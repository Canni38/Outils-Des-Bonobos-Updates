ALTER TABLE users
    ADD COLUMN last_login_at timestamptz;

CREATE UNIQUE INDEX external_identities_user_provider_idx
    ON external_identities(user_id, provider);

CREATE TABLE steam_openid_transactions (
    state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash) = 32),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX steam_openid_transactions_expiry_idx
    ON steam_openid_transactions(expires_at);

CREATE TABLE steam_openid_nonces (
    response_nonce text PRIMARY KEY,
    expires_at timestamptz NOT NULL
);

CREATE INDEX steam_openid_nonces_expiry_idx
    ON steam_openid_nonces(expires_at);

INSERT INTO permissions (code, description)
VALUES ('users.manage', 'Gérer le statut et le nom des utilisateurs')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT roles.id, permissions.id, 'GLOBAL'
FROM roles
CROSS JOIN permissions
WHERE roles.code = 'ADMINISTRATEUR'
  AND permissions.code = 'users.manage'
ON CONFLICT DO NOTHING;
