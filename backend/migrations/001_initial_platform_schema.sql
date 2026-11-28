CREATE TABLE games (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE
        CHECK (code ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
    status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE external_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
    subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 128),
    verified_at timestamptz NOT NULL,
    profile jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(profile) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
);

CREATE INDEX external_identities_user_id_idx ON external_identities(user_id);

CREATE TABLE roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE
        CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
    is_system boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE
        CHECK (code ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$'),
    description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 240),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE RESTRICT,
    scope text NOT NULL CHECK (scope IN ('GLOBAL', 'PROJECT')),
    PRIMARY KEY (role_id, permission_id, scope)
);

CREATE TABLE user_roles (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    granted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_id_idx ON user_roles(role_id);

CREATE TABLE projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id uuid REFERENCES games(id) ON DELETE RESTRICT,
    project_key text NOT NULL UNIQUE
        CHECK (project_key ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
    created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE applications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_key text NOT NULL UNIQUE
        CHECK (application_key ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_applications (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    application_id uuid NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, application_id)
);

CREATE TABLE project_memberships (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    granted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id, role_id)
);

CREATE INDEX project_memberships_user_id_idx ON project_memberships(user_id);

CREATE TABLE pages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    application_id uuid NOT NULL,
    page_key text NOT NULL CHECK (page_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    layout jsonb NOT NULL CHECK (jsonb_typeof(layout) = 'object'),
    status text NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'PUBLISHED')),
    updated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, application_id, page_key),
    FOREIGN KEY (project_id, application_id)
        REFERENCES project_applications(project_id, application_id)
        ON DELETE RESTRICT
);

CREATE TABLE page_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id uuid NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
    revision_number integer NOT NULL CHECK (revision_number > 0),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    layout jsonb NOT NULL CHECK (jsonb_typeof(layout) = 'object'),
    status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED')),
    created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (page_id, revision_number)
);

CREATE TABLE configurations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    application_id uuid NOT NULL,
    config_key text NOT NULL CHECK (char_length(config_key) BETWEEN 1 AND 160),
    format text NOT NULL CHECK (format IN ('json', 'xml', 'csv', 'text', 'binary')),
    json_content jsonb,
    text_content text,
    object_key text,
    status text NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'PUBLISHED')),
    updated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, application_id, config_key),
    FOREIGN KEY (project_id, application_id)
        REFERENCES project_applications(project_id, application_id)
        ON DELETE RESTRICT,
    CHECK (
        (format = 'json' AND json_content IS NOT NULL AND text_content IS NULL AND object_key IS NULL)
        OR
        (format IN ('xml', 'csv', 'text') AND json_content IS NULL AND text_content IS NOT NULL AND object_key IS NULL)
        OR
        (format = 'binary' AND json_content IS NULL AND text_content IS NULL AND object_key IS NOT NULL)
    )
);

CREATE TABLE configuration_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    configuration_id uuid NOT NULL REFERENCES configurations(id) ON DELETE RESTRICT,
    revision_number integer NOT NULL CHECK (revision_number > 0),
    format text NOT NULL CHECK (format IN ('json', 'xml', 'csv', 'text', 'binary')),
    json_content jsonb,
    text_content text,
    object_key text,
    status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED')),
    created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (configuration_id, revision_number),
    CHECK (
        (format = 'json' AND json_content IS NOT NULL AND text_content IS NULL AND object_key IS NULL)
        OR
        (format IN ('xml', 'csv', 'text') AND json_content IS NULL AND text_content IS NOT NULL AND object_key IS NULL)
        OR
        (format = 'binary' AND json_content IS NULL AND text_content IS NULL AND object_key IS NOT NULL)
    )
);

CREATE TABLE user_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_sessions_user_active_idx
    ON user_sessions(user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE platform_bootstrap_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    initial_admin_claimed_at timestamptz,
    initial_admin_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    CHECK (
        (initial_admin_claimed_at IS NULL AND initial_admin_user_id IS NULL)
        OR
        (initial_admin_claimed_at IS NOT NULL AND initial_admin_user_id IS NOT NULL)
    )
);

INSERT INTO platform_bootstrap_state (singleton) VALUES (true);

CREATE TABLE activity_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
    action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
    entity_type text NOT NULL CHECK (char_length(entity_type) BETWEEN 1 AND 80),
    entity_id text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(details) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_log_project_created_idx
    ON activity_log(project_id, created_at DESC);
CREATE INDEX activity_log_actor_created_idx
    ON activity_log(actor_user_id, created_at DESC);

INSERT INTO roles (code, display_name, is_system)
VALUES
    ('ADMINISTRATEUR', 'Administrateur', true),
    ('UTILISATEUR', 'Utilisateur', true);

INSERT INTO permissions (code, description)
VALUES
    ('users.read', 'Consulter les utilisateurs'),
    ('users.roles.manage', 'Modifier les rôles globaux des utilisateurs'),
    ('projects.read', 'Consulter les projets autorisés'),
    ('projects.manage', 'Créer et administrer les projets'),
    ('applications.read', 'Consulter les applications autorisées'),
    ('applications.manage', 'Gérer le catalogue des applications'),
    ('layouts.read', 'Consulter les mises en page autorisées'),
    ('layouts.write', 'Modifier les mises en page'),
    ('layouts.publish', 'Publier et restaurer des versions de mise en page'),
    ('configurations.read', 'Consulter les configurations autorisées'),
    ('configurations.write', 'Modifier les configurations'),
    ('activity.read', 'Consulter les journaux d’activité'),
    ('administration.access', 'Accéder aux fonctions d’administration');

INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT roles.id, permissions.id, 'GLOBAL'
FROM roles CROSS JOIN permissions
WHERE roles.code = 'ADMINISTRATEUR';

INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT roles.id, permissions.id, 'PROJECT'
FROM roles
CROSS JOIN permissions
WHERE roles.code = 'UTILISATEUR'
  AND permissions.code IN (
      'projects.read',
      'applications.read',
      'layouts.read',
      'configurations.read'
  );
