-- Human Evaluation study schema.
-- Paste into the Supabase SQL editor and run once.
--
-- Security model: RLS is enabled on every table and NO policies are created,
-- so the anon and authenticated roles can read nothing at all. Only the server,
-- holding the service_role key, can reach this data. That is what keeps the
-- study blind: strata, sense ids and pipeline predictions never travel to a
-- browser.

-- ---------------------------------------------------------------- annotators
create table if not exists annotators (
  annotator_id text primary key,
  created_at   timestamptz not null default now(),
  consent_at   timestamptz,
  training     jsonb not null default '{"answers":{},"completed_at":null,"n_correct":0}'::jsonb,
  last_seen    timestamptz
);

-- ------------------------------------------------- per-annotator item queues
-- Generated once at first sign-in: randomized order, HE2 side assignment, and
-- injected duplicate items for intra-rater consistency.
create table if not exists queue_items (
  annotator_id text not null references annotators(annotator_id) on delete cascade,
  task         text not null check (task in ('he1','he2')),
  idx          integer not null,
  item_id      text not null,
  flip         boolean not null default false,
  is_duplicate boolean not null default false,
  dup_of_idx   integer,
  primary key (annotator_id, task, idx)
);
create index if not exists queue_items_lookup on queue_items (annotator_id, task, idx);

-- --------------------------------------------------- HE1: concept coverage
-- One row per (annotator, queue position). `annotations` holds the concepts
-- recorded for that abstract — dragged spans keep offsets, typed concepts do
-- not. The queue position, not the paper id, is the key: a paper deliberately
-- reappears later in the queue as a repeat measurement.
create table if not exists he1_responses (
  annotator_id     text not null references annotators(annotator_id) on delete cascade,
  queue_idx        integer not null,
  paper_id         text not null,
  is_duplicate     boolean not null default false,
  dup_of_idx       integer,
  annotations      jsonb not null default '[]'::jsonb,
  no_concepts      boolean not null default false,
  notes            text default '',
  response_time_ms bigint not null default 0,
  visits           integer not null default 0,
  first_opened_at  timestamptz,
  updated_at       timestamptz,
  completed_at     timestamptz,
  primary key (annotator_id, queue_idx)
);
create index if not exists he1_responses_paper on he1_responses (paper_id);

-- ------------------------------------------------- HE2: concept identity
create table if not exists he2_responses (
  annotator_id        text not null references annotators(annotator_id) on delete cascade,
  queue_idx           integer not null,
  pair_id             text not null,
  is_duplicate        boolean not null default false,
  dup_of_idx          integer,
  displayed_left      text,           -- which source side ('A'/'B') was shown on the left
  identity_judgment   text check (identity_judgment in ('SAME','DIFFERENT','CANNOT')),
  relation_judgment   text check (relation_judgment in ('BN','PW','RE','UN','CANNOT')),
  direction_displayed text check (direction_displayed in ('LEFT','RIGHT','CANNOT')),
  direction           text check (direction in ('A','B','CANNOT')),
  notes               text default '',
  response_time_ms    bigint not null default 0,
  visits              integer not null default 0,
  first_opened_at     timestamptz,
  updated_at          timestamptz,
  completed_at        timestamptz,
  primary key (annotator_id, queue_idx)
);
create index if not exists he2_responses_pair on he2_responses (pair_id);

-- --------------------------------------------------- adjudicated gold sets
create table if not exists he1_gold (
  paper_id    text primary key,
  gold        jsonb not null default '[]'::jsonb,
  adjudicator text,
  note        text default '',
  updated_at  timestamptz
);

create table if not exists he2_consensus (
  pair_id     text primary key,
  identity    text,
  relation    text,
  direction   text,
  adjudicator text,
  note        text default '',
  updated_at  timestamptz
);

-- ----------------------------------------------------------------- audit log
create table if not exists events (
  id      bigserial primary key,
  t       timestamptz not null default now(),
  payload jsonb not null
);

-- --------------------------------------------------------------------- RLS
alter table annotators    enable row level security;
alter table queue_items   enable row level security;
alter table he1_responses enable row level security;
alter table he2_responses enable row level security;
alter table he1_gold      enable row level security;
alter table he2_consensus enable row level security;
alter table events        enable row level security;
-- deliberately no policies: only service_role (the server) may read or write.

-- ------------------------------------------------------- analysis-friendly views
-- One row per recorded concept, for SQL analysis of HE1.
create or replace view he1_concepts as
select r.annotator_id,
       r.paper_id,
       r.queue_idx,
       r.is_duplicate as is_repeat_measurement,
       a->>'annotation_id'                as annotation_id,
       nullif(a->>'span_start','')::int   as span_start,
       nullif(a->>'span_end','')::int     as span_end,
       a->>'raw_span'                     as raw_span,
       a->>'label'                        as concept_label,
       coalesce(a->>'source','span')      as entry_mode,
       r.response_time_ms,
       r.completed_at
from he1_responses r
cross join lateral jsonb_array_elements(r.annotations) as a
where r.completed_at is not null;

-- Both annotators' identity judgments side by side, for agreement queries.
create or replace view he2_agreement as
select a.pair_id,
       a.annotator_id      as coder_a,
       a.identity_judgment as identity_a,
       a.relation_judgment as relation_a,
       b.annotator_id      as coder_b,
       b.identity_judgment as identity_b,
       b.relation_judgment as relation_b,
       (a.identity_judgment = b.identity_judgment) as identity_match
from he2_responses a
join he2_responses b
  on a.pair_id = b.pair_id
 and a.annotator_id < b.annotator_id
where a.completed_at is not null
  and b.completed_at is not null
  and a.is_duplicate = false
  and b.is_duplicate = false;
