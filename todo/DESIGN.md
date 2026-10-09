# Gavin's Todolist: design direction

Written down from the owner's answers (9 Oct 2026). This file is the direction; the antislop
rules filter what gets built on top of it.

## Direction from the owner

- **Keep the current layout and core design**, and every feature the owner asked for.
- **Default look: the Discord preset** (Discord's greys and blurple). Asked for by the owner.
  Classic green and Mono + Blue stay as choices, and Personalize lets people set their own colours.
- **Interface emoji become drawn icons**, in the app's own line style (20 px grid, rounded
  stroke, the same set the sidebar already uses). Where an icon doesn't help someone scan,
  plain text. Emoji people choose themselves stay as content: list and group icons, notes,
  WhatsApp message text.
- **Personalize It**: a paint palette icon (not a sparkle). Its default gradient is built
  from the look's own accent colour, not blue to purple. People can still pick any gradient.
- **Labels in sentence case** ("Lists", "Next exam"), not small uppercase with wide spacing.
- Kept exactly as the owner wrote it: the "Buddy's number" line in *Where should Buddy
  message you?*.

## What already defines the look (kept)

- **Type**: Plus Jakarta Sans, 400 to 800. Shared with Whats Up so both read as one app;
  friendly, geometric, and still clear at 12.5 px.
- **Colour**: one action colour per preset (`--leaf`: blurple in Discord), neutrals for
  everything else. List colours are a fixed categorical set, always shown next to a name.
  Status uses traffic-light colours (not started red, in progress amber, done green): a
  meaning, not decoration.
- **Shape**: radius 8 / 8 / 12 in Discord (controls / menus / cards).
- **Identity motif**: the status ring. Every task starts with a circle you tap through
  not started, in progress, done; the logo is the same ring with the tick.
- **One playful accent**: the Personalize It gradient (button, board title and board rule).
- **Motion**: short transitions on hover and open, plus the celebration when a task or a
  whole day is done. Nothing loops.

## Dials

`Dial: ENERGY 2 / RHYTHM 2 / MOTION 2`

Reading this as: a personal and small-group to-do and study planner for secondary-school
students, living inside Whats Up, in its existing Discord-grey, blurple-accent language.

## Decisions in the 3.8 redesign

- **Icons**: `src/components/Icon.tsx`, one set drawn for this app (20 px grid, 1.7 stroke,
  round caps). Each mark names a thing on screen: a sun for the morning brief, a pin for
  a task someone gave you, a palette for Personalize It. Marks that only decorated are gone.
- **Accent as text**: `--leaf-text` is the accent colour when it's used as words (links,
  selected rows, counts). It's set per look and theme so it passes 4.5:1 on its backgrounds;
  `--leaf` stays for fills, borders and switches.
- **Personalize It gradient**: by default `--leaf-strong` deepening away from the text on it
  (`--pz-shade`: darker under white text, lighter under dark text). The board title uses the
  accent-as-text version, since it sits on the page.
- **Contrast**: every text colour on every screen, in all three looks, light and dark, is
  checked against WCAG AA. Priority, danger, exam and subject colours were darkened (light)
  or lightened (dark) until they pass; meaning and hue are unchanged.
