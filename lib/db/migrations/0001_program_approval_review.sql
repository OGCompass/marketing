CREATE TABLE program_approval_review (
  id varchar(40) PRIMARY KEY,
  revision integer NOT NULL DEFAULT 0,
  source_version varchar(64) NOT NULL,
  rule_version varchar(64) NOT NULL,
  inventory_generated_at timestamptz,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  section_approvals jsonb NOT NULL DEFAULT '{}'::jsonb,
  final_signoff jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE program_approval_history (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision integer NOT NULL,
  action varchar(24) NOT NULL,
  section_id varchar(80),
  actor_user_id text NOT NULL,
  reviewer_label varchar(80) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source_version varchar(64) NOT NULL,
  summary text NOT NULL
);