# Club World Cup Picker

First-come club picker for the eFootball Club World Cup tournament: 32 clubs from the 2025 edition, one per player.

- Participants open the link, type their name and lock in a club. No login. A pick is tied to the browser it was made in (random token in localStorage), so only that browser can release it.
- The organiser taps **Organiser login** at the bottom and enters `ADMIN_PASSWORD`. Organiser mode can free up any club and assign a club to a named player.
- Picks are stored in Postgres (`picks` table, created on boot). Club and player are each unique, so two people tapping the same club at once can't both get it.
- Open pages poll `/api/picks` every 3 seconds.

## Run locally

    ADMIN_PASSWORD=local-test node server.js   # http://localhost:3081, picks kept in memory

## Deploy (Render Blueprint)

`render.yaml` creates a free web service plus a free Postgres database. Set the `ADMIN_PASSWORD` secret when Render asks.
The free database expires 30 days after creation; the free web service sleeps after 15 minutes idle and takes about a minute to wake.

Crests: club logos from Wikipedia, downscaled to 128 px WebP in `crests.json`.
