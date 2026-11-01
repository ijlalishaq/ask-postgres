# ask-postgres

Ask a Postgres database a question in plain English and get back the SQL, the rows and a short answer. Claude looks around with read-only queries before it commits to an answer, and every query it runs goes through [agent-guardrails](https://github.com/ijlalishaq/agent-guardrails) and a database connection that cannot write.

Most text-to-SQL demos show a handful of hand-picked questions. I wanted numbers I could defend, so the repo also contains a harness for BIRD Mini-Dev, the 500-question Postgres set, and measures each approach against the official scoring. That includes a run of BIRD's own baseline prompt, to check the harness reproduces the published scores before trusting anything else it says.

## Results

All 500 Mini-Dev questions (2026 release), scored by execution accuracy (EX): the predicted query and the gold query are run, and the question counts as solved when the two results are equal as sets of rows. The intervals are 95% Wilson intervals.

| model | approach | EX | 95% interval | $ per 1k questions | seconds per question |
|---|---|---:|---|---:|---:|
| Haiku 5.5 | BIRD baseline prompt | 59.8 | 55.4 to 64.0 | 0.93 | 5.3 |
| Haiku 5.5 | one shot, catalog schema | 68.2 | 64.0 to 72.1 | 0.92 | 4.9 |
| Haiku 5.5 | one shot, again | 70.8 | 66.7 to 74.6 | 0.92 | 4.9 |
| Haiku 5.5 | one shot with repair | 70.2 | 66.0 to 74.0 | 0.95 | 5.2 |
| Haiku 5.5 | agent | 74.4 | 70.4 to 78.0 | 1.45 | 6.3 |
| Haiku 5.5 | agent, again | 75.6 | 71.6 to 79.2 | 1.44 | 6.4 |
| Haiku 5.5 | agent, vote of 3 | 76.4 | 72.5 to 79.9 | 4.35 | 7.6 |
| Sonnet 5.5 | BIRD baseline prompt | 87.4 | 84.2 to 90.0 | 14.51 | 5.7 |
| Sonnet 5.5 | agent | 88.2 | 85.1 to 90.7 | 21.58 | 7.2 |

The published Postgres EX for the baseline prompt is 58.6 for Haiku 5.5 and 85.6 for Sonnet 5.5. Both are inside the intervals above, which is the main reason I believe the rest of the table.

Comparing two runs question by question is much tighter than comparing two accuracies, so `pnpm bench:report` also prints every pair with a paired bootstrap interval on the difference. What I take from it:

The schema text matters more than anything that happens after it. The baseline prompt and "one shot" both make a single call with the same output rules. The only difference is that one shot gets the schema read from the live catalog, with row counts, column descriptions and example values, and that is worth 8 to 11 points on Haiku.

Letting the model explore helps a small model and does nothing for a large one. The Haiku agent beats Haiku one shot by 3.6 to 6.2 points for about 1.6 times the cost (the interval against the second one-shot run just touches zero). On Sonnet the agent is 0.8 points ahead of the baseline prompt, with an interval of -2.2 to 3.8, and costs 50% more. Haiku with the agent gets three quarters of the questions right at a fifteenth of what the Sonnet agent costs.

Repair and voting didn't earn their cost. Repair (rerun on an error or an empty result) is within noise of plain one shot. It fired on only 13 of the 500 questions, because Haiku's wrong queries almost always run fine and return plausible rows. Voting three agent runs gains 2.0 points over one, interval -4.8 to 0.8, for three times the cost.

Runs are noisy at the level of single questions even when the totals look stable. Two identical one-shot runs disagree on 53 of the 500 questions and two agent runs on 66, while their totals differ by 2.6 and 1.2 points. My first pilot on 20 questions showed a 20-point gap between two setups that turned out to be the same thing run twice, which is why every number here is on the full set with a repeat.

## Where it goes wrong

I went through the 92 questions the Haiku agent got wrong in both of its runs and sorted each one by hand. The full list with a note per question is in [results/misses-agent-haiku.csv](results/misses-agent-haiku.csv).

| | questions |
|---|---:|
| the model got it wrong | 53 |
| the answer was right but scored as wrong | 26 |
| the question is ambiguous or the gold query is questionable | 13 |

The second group is the one I didn't expect to be so large. BIRD compares raw values, so `47.6666666666666667` (numeric) and `47.666666666666664` (double precision) are different answers, as are one row per group against one row with a column per group, and the same columns in a different order. Nine of the 26 are numeric against double precision, seven are the shape of the result, and the rest are rounding nobody asked for, float4 columns and column order. The scorer keeps this strictness on purpose, since loosening it would make the numbers incomparable with everyone else's. It does mean that more than a quarter of the questions the agent reliably misses are a formatting disagreement, not a wrong answer.

Among the real mistakes, a few patterns repeat:

- Counting printings instead of cards. In `card_games` one card has a row per printing, and a question about "different cards" needs `COUNT(DISTINCT name)`. Nine of the misses are this, and it's most of the gap between Haiku (69.6 on that database) and Sonnet (92.8).
- Returning an id where a name was wanted (six), usually `district_id` when the question asked which district.
- Comparing a list column with `=`. Diagnoses in `thrombosis_prediction` are stored as text like `SLE, PSS`, and `diagnosis = 'SLE'` misses most of them (five).
- Leaving out groups whose count is zero when the question asks for every element or every season (five).
- Not splitting comma-separated items in `student_club` expenses even when the hint says one record can list several (three).
- Forgetting that `satscores` mixes school and district rows (`rtype = 'S'`) (three).

Of the 13 question problems, two are gold queries that contradict the question: one asks for a year as text and the gold returns a number, and one says to use local start times while the gold compares UTC. The others have two reasonable readings, or the same fact is stored in two tables that disagree, and the gold picked the other one.

## How it works

The schema the model sees is generated from `pg_catalog` at startup, not written by hand. Each table is rendered as DDL with its approximate row count, each column with its comment and a few example values taken from `pg_stats`, and the foreign keys. A table from the `financial` database looks like this:

```sql
CREATE TABLE account ( -- about 4,500 rows
  account_id bigint, -- the id of the account; e.g. 1, 47, 97
  district_id bigint, -- location of branch; e.g. 1, 70, 74
  frequency text, -- frequency of the acount; e.g. 'POPLATEK MESICNE', 'POPLATEK TYDNE', 'POPLATEK PO OBRATU'
  date date, -- the creation date of the account; e.g. '1993-02-08', '1993-10-08', '1996-06-25'
  PRIMARY KEY (account_id),
  FOREIGN KEY (district_id) REFERENCES district (district_id)
);
```

Example values are how the model finds out that weekly statements are stored as `'POPLATEK TYDNE'` without spending a query on it. Column comments are ordinary `COMMENT ON COLUMN`, so on your own database you get the same effect by writing them.

The agent has two tools. `run_sql` runs an exploratory query and shows the first 50 rows; `submit_answer` runs the final query and shows it the first rows, so it can check them and submit again (the last submission counts) before answering in a sentence or two. It has a 16-step limit, 15 tool calls and a cost cap of $0.25 per question, all enforced by agent-guardrails, which also writes every model call, tool call and decision to a hash-chained audit log. A Haiku question averages 3.7 model calls and 3.4 queries.

## Read-only, several times over

A text-to-SQL tool that can be talked into `DROP TABLE` is not a tool anyone should deploy, so each of these stops a write on its own:

1. It connects as a role with `SELECT` only and `default_transaction_read_only = on`. On startup it checks the role for any `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` or `CREATE` privilege and refuses to run if it finds one, unless you pass `--allow-writable-role`.
2. Every query runs inside `BEGIN READ ONLY` with a `SET LOCAL statement_timeout`, and is rolled back afterwards.
3. Queries go over the extended protocol, where Postgres refuses a string with more than one statement, so `SELECT 1; DELETE FROM x` fails as a whole.
4. Before `run_sql` executes anything it asks the planner for an estimate, and queries with a total cost over 5 million are refused with a message asking the model to narrow them. This is about accidental cross joins on large tables, not attackers.
5. The guardrails policy has a rule that rejects anything that doesn't start with `SELECT`, `WITH`, `VALUES`, `TABLE` or `EXPLAIN`, or that holds more than one statement, before it reaches the database. When it blocks a call, the model is told why. After three blocks the run is handed off instead of retried.

## Running it

You need Node 22 or later and pnpm. Postgres can be your own, or the one this repo can run locally from the `embedded-postgres` binaries, which needs nothing installed system-wide.

```sh
pnpm install
cp .env.example .env        # then set ANTHROPIC_API_KEY
```

Point it at a database through a read-only role:

```sh
export DATABASE_URL=postgres://reader@localhost:5432/mydb
pnpm ask "which five customers spent the most last quarter?"
pnpm ask --schema                                  # the schema text the model sees
pnpm ask "..." --model claude-sonnet-5-5 --hint "fiscal quarters start in February"
```

It prints the SQL it settled on, the first rows, the answer, and how many calls and how much money it took.

There is also a small HTTP API:

```sh
pnpm serve                  # PORT=8787 by default
curl -s localhost:8787/ask -H 'content-type: application/json' \
  -d '{"question": "how many accounts were opened in 1996?"}'
```

`POST /ask` returns the run id, status, answer, SQL, columns, up to 200 rows, cost and counts. `GET /schema` returns the schema text and `GET /health` the database name. Every request's agent run is appended to `audit.jsonl` (set `AUDIT_LOG` to change it), so you can see later exactly which queries ran for which question.

`pnpm test` runs the unit and integration tests against a throwaway Postgres cluster on a random port, with a scripted model, so it needs no API key and costs nothing.

## Reproducing the benchmark

The questions are downloaded from the `birdsql/bird_mini_dev` dataset on Hugging Face at a pinned revision, and the databases from the layer of BIRD's official Postgres image that holds the dumps (227 MB, fetched straight from the registry, no Docker needed). Every file is checked against a SHA-256 before it's used.

```sh
pnpm pg init && pnpm pg start    # local Postgres 18 on port 54329, data in .data/pg
pnpm bench:download              # questions, baseline prompts and dumps into .data/bird
pnpm bench:restore               # one database per db_id, plus the read-only role (needs pg_restore)
pnpm bench:check                 # all 500 gold queries run and return rows
```

Then run, score and compare:

```sh
pnpm bench:run --strategy agent --model claude-haiku-5-5 --concurrency 6
pnpm bench:score runs/agent--claude-haiku-5-5.jsonl
pnpm bench:report
```

Strategies are `bird-prompt`, `oneshot`, `oneshot-repair`, `agent` and `agent-vote3`. A run appends one line per question to `runs/`, so an interrupted run picks up where it stopped, and `--limit` or `--ids` run a subset. Scoring and reports don't call the model. The whole table above cost $23.53 in API calls, three quarters of it the two Sonnet runs, and each run took ten minutes or less at concurrency 6. The run files are committed, so `pnpm bench:score` and `pnpm bench:report` reproduce the table without spending anything.

## Notes on the benchmark

The 2026 release of Mini-Dev is much harder than the original. 460 of the 500 questions are labelled challenging, 32 moderate and 8 simple, so the per-difficulty numbers for the last two groups are too small to read anything into.

Scoring mirrors BIRD's evaluation script, which compares Python sets of rows as psycopg2 returns them. Numbers compare by exact value (so `1.50` numeric equals `1.5` numeric, but a double never equals the decimal it was printed as), booleans as 0 and 1, and dates, timestamps and text are kept apart. Each query gets 30 seconds. Running the gold queries as predictions scores 100%, and shifting every gold query to the next question scores 0.2%.

Scores were not reproducible at first. A few questions flipped between right and wrong when the same predictions were scored twice. The cause was `SUM` over `real` (float4) columns, whose result depends on the order the rows are added in, which a parallel plan changes from run to run. `bench:restore` turns parallel query off for these databases, and `bench:check` reruns every gold query with parallelism forced on to confirm none of the 500 gold answers depends on the plan. The instability only ever came from predicted queries.

The official image runs Postgres 14 and this repo uses 18. All 500 gold queries return rows on 18, and the baseline scores match the published ones, so I don't think it matters here, but it is a difference.

BIRD has been public since 2023, so models may have seen its questions or their SQL during training. The 2026 questions are rewritten, which should help, but contamination can't be ruled out, and it would lift every row in the table, not just some.

## Limitations

The schema goes into the prompt whole. That's fine for these databases (the largest has 13 tables) and for most application databases, but on a warehouse with hundreds of tables the prompt gets expensive and the model gets worse at picking tables. The fix is retrieval over tables before the agent starts, and it isn't built.

The agent only reads. It doesn't learn from earlier questions, keep a glossary, or ask a clarifying question when the request is ambiguous, and ambiguity accounts for some of its misses.

Accuracy on a benchmark is not accuracy on your data. BIRD's databases come with column descriptions, and the numbers above lean on them. On a database without comments, expect worse until you write some.

## Licence

MIT, see [LICENSE](LICENSE). BIRD Mini-Dev is released under CC BY-SA 4.0 by its authors (Li et al., "Can LLM Already Serve as A Database Interface? A BIg Bench for Large-Scale Database Grounded Text-to-SQLs", NeurIPS 2023). The code downloads it rather than shipping it. The files in `runs/` and `results/` hold excerpts of it (question text, gold SQL and rows returned by queries), so those two folders are under CC BY-SA 4.0 as well.
