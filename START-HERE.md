# 🧽 Crew Clock — Start Here

A dead-simple clock-in / clock-out system for a mobile cleaning crew.

- Workers open **one link**, tap their name, and clock in — no passwords.
- After finishing a job they get a **live 30-minute countdown** to reach the next one.
- Miss it → a **1-hour penalty is logged automatically** (you can waive it).
- You watch everyone **live** from the owner dashboard.

---

## What each person sees

- **Your workers** → the link you share (e.g. `https://your-crew.onrender.com`)
  Big buttons: **Clock In → Start Job → Finished → (30-min timer) → Start Next Job → Clock Out**
- **You (owner)** → the same link with `/admin` on the end (e.g. `.../admin`)
  Protected by your PIN. Live crew status, penalties, today's log, add/remove workers, settings.

---

## Try it on your own computer first (2 minutes)

1. Open the **Terminal** app.
2. Copy-paste this and press Enter:
   ```
   cd ~/Desktop/crew-clock && npm start
   ```
3. Open your browser to **http://localhost:3000** (worker view)
   and **http://localhost:3000/admin** (owner view — default PIN is `1234`).
4. Press `Ctrl + C` in Terminal to stop it.

> This only works while your computer is on. For a permanent link to share, do the cloud step below.

---

## Get your permanent shareable link (free, ~10 minutes)

You'll put the code on the internet with **Render**. One-time setup, then it's always online.

### Step 1 — Put the code on GitHub
1. Make a free account at https://github.com
2. Create a new repository called `crew-clock`.
3. Upload the whole `crew-clock` folder (drag-and-drop works on GitHub's "upload files" page).
   Do **not** upload the `node_modules` folder — it's not needed.

### Step 2 — Deploy on Render
1. Make a free account at https://render.com and connect your GitHub.
2. Click **New → Web Service**, pick your `crew-clock` repo.
3. Render reads the included `render.yaml` automatically. Confirm:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
4. When asked for **ADMIN_PIN**, type a secret PIN only you know (e.g. `7391`).
5. Click **Create**. Wait a couple of minutes for it to go live.
6. Render gives you a link like `https://crew-clock-xxxx.onrender.com` — **that's your link.**

### Step 3 — Set up your crew
1. Open `https://your-link.onrender.com/admin`, enter your PIN.
2. Go to the **Workers** tab → remove the two "Example Worker" entries → add your real workers.
3. (Optional) **Settings** tab → set the travel window, penalty hours, and hourly rate.

### Step 4 — Share on WhatsApp
Copy your link (the **Settings** tab has a "Copy link" button) and send it to your crew:

> *"Team — bookmark this. Tap your name, Clock In when you start, mark each job Finished,
> and you've got 30 min to start the next one. Clock Out at the end of the day."*

Tell them to tap **Share → Add to Home Screen** so it opens like an app.

---

## Good to know

- **Free Render tier** goes to sleep after 15 min of no use, so the first open of the day
  may take ~30 seconds to wake up. The **Starter** plan (set in `render.yaml`) stays awake
  and — importantly — keeps a **persistent disk** so your history is never lost. Recommended
  once you're relying on it for pay.
- **Change the travel window / penalty / hourly rate** anytime in the **Settings** tab.
- **Waive a penalty** (someone had a real reason) in the **Penalties** tab — one tap.
- **Removing a worker** hides them but keeps their past records.
- All times are stored safely and shown in your local time.

---

## The rules the system enforces

| Worker action | What happens |
|---|---|
| Clock In | Their shift starts, they show as "On shift" on your dashboard |
| Start Job | Status → **Working** |
| Finished — Mark Done | A **30-min countdown** begins to reach the next job |
| Start Next Job (in time) | Countdown cleared, no penalty |
| Countdown hits 0 | **1-hour penalty auto-logged**, flagged red for you |
| Clock Out | Leash ends for the day — no penalty for stopping |
