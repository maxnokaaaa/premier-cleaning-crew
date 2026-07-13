# 🧽 Premier Cleaning — Crew Clock

Your staff clock-in system is **live, permanent, and online 24/7**. It no longer
runs on your Mac — it's hosted in the cloud, so it works whether your computer is
on or off.

---

## 🔗 Your links

**For your cleaners** (share this on WhatsApp):
> **https://premier-cleaning-crew.onrender.com**
They tap their name — no password.

**For you** (the owner dashboard):
> **https://premier-cleaning-crew.onrender.com/admin**
> Owner PIN: **2101**

---

## ✅ What's already set up

- Hosted on **Render** (free plan) — permanent link, always online.
- Data stored in a **Turso cloud database** (free) — clock-ins, hours, penalties
  and photos are kept **forever**, even across restarts.
- Timezone set to **Malta**, currency **€**.
- One worker added (**NIHAL**) — add the rest in the dashboard's **Workers** tab.

> Note: the free plan "sleeps" after 15 min of no use, so the **first** person to
> open it each day may wait ~30–50 seconds for it to wake up. After that it's instant.

---

## 📅 The one thing left for you: connect your Premier calendar (2 minutes)

This makes your real jobs appear automatically for cleaners to tap.

1. Open **Google Calendar** on the **premiercleaningmalta@gmail.com** account.
2. Hover over **"Premier Malta"** (left sidebar) → click the **⋮** → **Settings and sharing**.
3. Scroll down to **"Integrate calendar"**.
4. Find **"Secret address in iCal format"**, click the eye 👁 to reveal it, and **copy** it.
5. Open your **owner dashboard → Settings tab → "Premier calendar link"**, paste it in,
   and click **Save calendar link**.

Done — every day's jobs (Elizabeth, Marija, etc.) will show up for your cleaners to pick,
with the full job sheet and address.

*(Keep that secret link private — anyone with it can read your calendar.)*

---

## 🛠 If you ever need to change the code

The code lives here and on GitHub (**github.com/maxnokaaaa/premier-cleaning-crew**).
Any change pushed to GitHub auto-deploys to the live site. Just ask me.

- **Change the owner PIN:** Render dashboard → your service → Environment → edit `ADMIN_PIN`.
- **Add/remove workers, set pay rate, penalties, checklists:** all in the owner dashboard.
