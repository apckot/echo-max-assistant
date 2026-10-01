import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';

const root = process.cwd();
const modulesRoot = join(root, 'src', 'modules');
const sourceExtensions = /\.(?:[cm]?ts|tsx)$/;
const adapterSegments = new Set(['infrastructure', 'adapters', 'adapter', 'http', 'providers', 'provider', 'max']);
const externalPackages = /^(?:fastify|pg|pg-native|postgres|@maxhub|max-bot-api|openai|@openai|@yandex-cloud|gigachat|@tbank)(?:\/|$)/;

function* sourceFiles(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(file);
    else if (entry.isFile() && sourceExtensions.test(entry.name)) yield file;
  }
}

function layerOf(file) {
  const parts = relative(modulesRoot, file).split(sep);
  if (parts.length < 3 || parts[0]?.startsWith('..')) return undefined;
  return parts[1] === 'application' || parts[1] === 'domain' ? parts[1] : undefined;
}

function dependencies(source) {
  const scanner = createScanner(true, undefined, source);
  const tokens = [];
  for (let kind; (kind = scanner.scan()) !== SyntaxKind.EndOfFile;) {
    tokens.push({ kind, value: scanner.getTokenValue() });
  }
  const imports = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token.kind === SyntaxKind.ImportKeyword || token.kind === SyntaxKind.ExportKeyword) {
      if (next?.kind === SyntaxKind.StringLiteral) imports.push(next.value);
      else if (next?.kind === SyntaxKind.OpenParenToken && tokens[i + 2]?.kind === SyntaxKind.StringLiteral) {
        imports.push(tokens[i + 2].value);
      } else {
        for (let j = i + 1; j < tokens.length && tokens[j].kind !== SyntaxKind.SemicolonToken; j++) {
          if (tokens[j].kind === SyntaxKind.FromKeyword && tokens[j + 1]?.kind === SyntaxKind.StringLiteral) {
            imports.push(tokens[j + 1].value);
            break;
          }
        }
      }
    } else if (token.value === 'require' && next?.kind === SyntaxKind.OpenParenToken &&
      tokens[i + 2]?.kind === SyntaxKind.StringLiteral) {
      imports.push(tokens[i + 2].value);
    }
  }
  return imports;
}

function existingSource(path) {
  const candidates = [path];
  const extension = extname(path);
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    candidates.push(path.slice(0, -extension.length) + '.ts', path.slice(0, -extension.length) + '.tsx');
  } else if (!extension) {
    candidates.push(`${path}.ts`, `${path}.tsx`, `${path}.mts`, `${path}.cts`, join(path, 'index.ts'));
  }
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function resolveTarget(specifier, importer, config) {
  if (specifier.startsWith('.')) {
    const path = resolve(dirname(importer), specifier);
    return existingSource(path) ?? path;
  }
  const compiler = config.compilerOptions ?? {};
  const base = resolve(root, compiler.baseUrl ?? '.');
  for (const [pattern, replacements] of Object.entries(compiler.paths ?? {})) {
    const star = pattern.indexOf('*');
    const prefix = star < 0 ? pattern : pattern.slice(0, star);
    const suffix = star < 0 ? '' : pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) ||
      (star < 0 && specifier !== pattern)) continue;
    const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const replacement of replacements) {
      const candidate = resolve(base, replacement.replace('*', middle));
      const file = existingSource(candidate);
      if (file) return file;
    }
  }
  return undefined;
}

try {
  const configPath = join(root, 'tsconfig.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const errors = [];
  for (const file of sourceFiles(modulesRoot)) {
    const layer = layerOf(file);
    if (!layer) continue;
    for (const dependency of dependencies(readFileSync(file, 'utf8'))) {
      const target = resolveTarget(dependency, file, config);
      const projectPath = target ? relative(root, target).split(sep) : [];
      const isExternal = externalPackages.test(dependency);
      const isAdapter = projectPath.some((part) => adapterSegments.has(part));
      const isOutwardDomainImport = layer === 'domain' && projectPath.includes('application');
      if (isExternal || isAdapter || isOutwardDomainImport) {
        const sourcePath = relative(root, file).split(sep).join('/');
        const targetPath = target ? relative(root, target).split(sep).join('/') : dependency;
        const reason = isExternal ? 'external adapter package' : isAdapter ? 'adapter/HTTP source' : 'application source from domain';
        errors.push(`${sourcePath}: forbidden import '${dependency}' -> ${targetPath} (${reason})`);
      }
    }
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Architecture boundaries: OK');
  }
} catch (error) {
  console.error(`Architecture check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
