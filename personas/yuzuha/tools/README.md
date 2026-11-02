Scripts that rebuild `corpus/` from raw downloads in `../raw/` (gitignored); run each with `python3 -I`, data paths as arguments.

Pipeline (in order):

1. Download (manual curl, see INDEX.md "Sources"): ZenlessData `TextMap/TextMap{,_EN}TemplateTb.json` + needed `FileCfg/*.json` → `raw/zenlessdata/`; `fetch_fandom.py TITLES.txt raw/fandom/pages.json` (fandom wikitext, used only for speaker labels and EN voice-overs).
2. `build_dialogue.py raw raw/dialogue.json` — groups TextMap dialogue lines into conversations, attributes speakers via EN TextMap ↔ fandom alignment.
3. `render_corpus.py raw/dialogue.json corpus` — writes `corpus/2x_*.md`.
4. `build_messages.py raw/zenlessdata OUT.md GROUP...` — phone messages (used to assemble `corpus/40_messages.md`; groups 441001–441007 90012 90013, mentions 440003 444002 445002).
5. `build_profile.py raw corpus` — `00_profile.md`, `10_voice_lines.md` (reads `raw/bwiki_promo.txt` for the promo section).
6. `build_topics.py raw corpus` — `30_relationships.md`, `50_world.md`.
