CREATE TABLE IF NOT EXISTS option_definitions (
  data_version TEXT NOT NULL,
  option_type INTEGER NOT NULL,
  handle TEXT NOT NULL,
  label_zh TEXT NOT NULL,
  description_template TEXT NOT NULL DEFAULT '',
  value_type TEXT NOT NULL CHECK (value_type IN ('integer','scaled_integer')),
  unit TEXT NOT NULL DEFAULT '',
  scale INTEGER NOT NULL DEFAULT 1 CHECK (scale > 0),
  allowed_operators_json TEXT NOT NULL CHECK (json_valid(allowed_operators_json)),
  param_policy_json TEXT NOT NULL CHECK (json_valid(param_policy_json)),
  repeat_policy TEXT NOT NULL CHECK (repeat_policy IN ('same','distinct')),
  display_template TEXT NOT NULL,
  search_tokens_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(search_tokens_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(data_version, option_type),
  UNIQUE(data_version, handle)
);

CREATE INDEX IF NOT EXISTS idx_option_definitions_type
  ON option_definitions(option_type, data_version);

CREATE TABLE IF NOT EXISTS option_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO option_definitions(
  data_version,option_type,handle,label_zh,description_template,value_type,unit,scale,
  allowed_operators_json,param_policy_json,repeat_policy,display_template,search_tokens_json,updated_at
) VALUES (
  'options-2026-09-20',12,'atk_plus','ATK +','攻击力增加 {value}','integer','points',1,
  '["eq","neq","gt","gte","lt","lte"]','{"mode":"ignored","filterable":false}',
  'same','ATK + {value}','["ATK","攻击力"]',0
);

INSERT OR IGNORE INTO option_state(id,current_version,updated_at)
VALUES (1,'options-2026-09-20',0);
