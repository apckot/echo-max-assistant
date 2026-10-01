CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timezone text NOT NULL DEFAULT 'Europe/Moscow' CHECK (length(trim(timezone)) > 0),
  locale text NOT NULL DEFAULT 'ru' CHECK (length(trim(locale)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.channel_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  provider text NOT NULL DEFAULT 'max' CHECK (provider = 'max'),
  external_user_id text NOT NULL CHECK (length(trim(external_user_id)) > 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'stopped')),
  -- No capability flag has been verified yet. A later migration may admit specific flags.
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (capabilities = '{}'::jsonb),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_user_id),
  UNIQUE (id, user_id)
);
CREATE INDEX channel_accounts_user_id_idx ON public.channel_accounts(user_id);

CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  channel_account_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'max' CHECK (provider = 'max'),
  external_conversation_id text NOT NULL CHECK (length(trim(external_conversation_id)) > 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'stopped')),
  next_inbound_sequence bigint NOT NULL DEFAULT 1 CHECK (next_inbound_sequence >= 1),
  next_apply_sequence bigint NOT NULL DEFAULT 1 CHECK (
    next_apply_sequence >= 1 AND next_apply_sequence <= next_inbound_sequence
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_account_tenant_fk FOREIGN KEY (channel_account_id, user_id)
    REFERENCES public.channel_accounts(id, user_id),
  UNIQUE (provider, external_conversation_id)
);
CREATE INDEX conversations_user_id_idx ON public.conversations(user_id);
CREATE INDEX conversations_channel_account_id_idx ON public.conversations(channel_account_id);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
ALTER TABLE public.channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations FORCE ROW LEVEL SECURITY;

-- Runtime privileges and tenant policies arrive with the dedicated RLS iteration.
REVOKE ALL ON public.users, public.channel_accounts, public.conversations
  FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;

UPDATE public.system_state SET schema_version = 3 WHERE id = 1 AND schema_version = 2;
