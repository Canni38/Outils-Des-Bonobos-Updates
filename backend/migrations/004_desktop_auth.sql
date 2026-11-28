CREATE TABLE desktop_auth_attempts (
    attempt_hash bytea PRIMARY KEY CHECK (octet_length(attempt_hash) = 32),
    code_challenge text NOT NULL
        CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
    app_state text NOT NULL
        CHECK (app_state ~ '^[A-Za-z0-9_-]{43}$'),
    expires_at timestamptz NOT NULL,
    started_at timestamptz,
    completed_at timestamptz,
    failure_code text
        CHECK (failure_code IN (
            'cancelled',
            'provider_unavailable',
            'invalid_openid_response'
        )),
    steam_id text CHECK (steam_id ~ '^[0-9]{17}$'),
    exchange_code_hash bytea UNIQUE
        CHECK (exchange_code_hash IS NULL OR octet_length(exchange_code_hash) = 32),
    exchange_expires_at timestamptz,
    exchanged_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (exchange_code_hash IS NULL AND exchange_expires_at IS NULL) OR
        (exchange_code_hash IS NOT NULL AND exchange_expires_at IS NOT NULL)
    ),
    CHECK (NOT (failure_code IS NOT NULL AND exchange_code_hash IS NOT NULL))
);

CREATE INDEX desktop_auth_attempts_expiry_idx
    ON desktop_auth_attempts(expires_at);

ALTER TABLE steam_openid_transactions
    ADD COLUMN desktop_attempt_hash bytea
        REFERENCES desktop_auth_attempts(attempt_hash) ON DELETE SET NULL;
