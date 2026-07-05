# Example decks

Ready-to-use JSON decks you can drop straight into `--deck=<path>` or into a
directory pointed at by `MERGE_ORACLE_DECKS_DIR`.

Each deck follows the schema documented in
[`docs/deck.schema.json`](../../docs/deck.schema.json) — see the README's
**Custom decks** section for the full field list.

## Decks in this folder

| File | Method | Cards | Notes |
| --- | --- | --- | --- |
| [`tiny-tarot.json`](./tiny-tarot.json)   | `tarot` | 5 | Great for demos. Only the 3-card spread will draw; `celtic-cross` needs ≥ 10 cards. |
| [`office-runes.json`](./office-runes.json) | `runes` | 6 | Workplace-flavored runes with emoji glyphs. |

## Try one

```sh
# Ad-hoc via path
oracle read PR.diff --method=tarot --deck=examples/decks/tiny-tarot.json

# Register a whole directory of decks via env var
export MERGE_ORACLE_DECKS_DIR=$PWD/examples/decks
oracle decks
oracle read PR.diff --method=runes --deck=office-runes
```

## Roll your own

Copy either file, change the `id` (must be unique across bundled + user decks),
tweak the cards, and re-run `oracle decks` to confirm it was picked up.
Missing fields will fail fast with a message pointing at the offending card
index.
