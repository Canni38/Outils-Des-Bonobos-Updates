CREATE TABLE platform_initial_admin_claims (
    steam_id text PRIMARY KEY
        CHECK (steam_id ~ '^[0-9]{17}$'),
    user_id uuid NOT NULL UNIQUE
        REFERENCES users(id) ON DELETE RESTRICT,
    claimed_at timestamptz NOT NULL
);

INSERT INTO platform_initial_admin_claims (steam_id, user_id, claimed_at)
SELECT external_identities.subject,
       platform_bootstrap_state.initial_admin_user_id,
       platform_bootstrap_state.initial_admin_claimed_at
FROM platform_bootstrap_state
JOIN external_identities
  ON external_identities.user_id =
     platform_bootstrap_state.initial_admin_user_id
 AND external_identities.provider = 'steam'
 AND external_identities.verified_at IS NOT NULL
WHERE platform_bootstrap_state.singleton = true
  AND platform_bootstrap_state.initial_admin_claimed_at IS NOT NULL
  AND platform_bootstrap_state.initial_admin_user_id IS NOT NULL
ON CONFLICT DO NOTHING;
