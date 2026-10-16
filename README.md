# Clicker Show — Host

The presenter app: project dashboard, media library, slide editor, HDMI presentation, and a phone remote. It works together with the separate **Clicker Show — Join** app that players open on their phones.

The interface is in English. Everything you type (questions, answers, project and team names) is written and displayed right-to-left, for Yiddish.

## Publish on GitHub Pages

1. Create a new repository (for example `clicker-host`) and upload **the contents of this folder** to the root of the repository. `index.html` must sit at the top level.
2. In the repository, go to **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
3. After a minute the site is live at `https://YOUR-USERNAME.github.io/clicker-host/`.
4. Publish the Join app the same way in its own repository.
5. Open the Host app. In **Join app address** at the top of the dashboard, paste the Join app's address (for example `https://YOUR-USERNAME.github.io/clicker-join/`) and press **Save**.

The QR codes on screen point to the address you save in step 5.

**Optional:** to pre-fill the address for anyone who opens your Host app, put it in `js/config.js` (`DEFAULT_JOIN_URL`). Your dashboard setting always takes priority over it.

**Custom domain:** in Settings → Pages you can set a domain such as `host.yourdomain.com`. Use a different domain or subdomain for the Join app.

## Running a show

1. **Create a project.** Use the "+" card. Upload MP3/WAV files once in the Media library; every project can use them.
2. **Build your slides.** For each slide, set:
   - Quiz or survey
   - The question and 1–5 answers
   - The correct answer
   - Team split, the timer, and typing speed

   Event settings hold the teams, background music, sound effects, and whether voting opens automatically.
3. **Present.** This opens a session with a 4-digit code. Then:
   - **Fullscreen** shows the presentation on this screen (good for a mirrored HDMI).
   - **Display window** opens a separate window. Drag it to the HDMI screen and click it for fullscreen.
   - **Remote** shows a QR code for *your* phone. It carries a secret key, so players can't control the show.
   - **Join QR** / **Join screen** shows the big QR code players scan.
4. **Run each slide.** The question types itself onto the screen, then voting opens and the timer runs. Voting closes when time runs out or when you press **Lock**. Press **Reveal** to show the answer.

### Keyboard

| Key | Action |
|---|---|
| → or PageDown | Next |
| ← or PageUp | Previous |
| Space | Open voting / pause / resume |
| S | Skip typing |
| L | Lock voting |
| R | Reveal |
| J | Join screen |
| 1 | Player count overlay |
| 2 | Percentages overlay |
| 3 | Team split overlay |
| 4 | Top 10 fastest overlay |
| M | Mute |
| B | Background music |
| F | Fullscreen |

The arrow and PageUp/PageDown keys also work in the display window, so a presenter clicker works there too.

### Resilience
- If the host page reloads, the session comes back with the same code, players and answers.
- Results can be exported as a CSV file.

## Good to know
- **Connections:** phones connect directly to the host computer using WebRTC. A free public server (PeerJS) only introduces the devices to each other; the answers don't pass through it.
- **Venue networks:** direct connections work on most Wi-Fi and mobile networks. Some strict corporate networks block them, so test at the venue first. If some phones can't connect, a TURN server can be added in `ICE_SERVERS` in `shared/protocol.js`.
- **Number of players:** about 150–250 players is a realistic limit for one host computer.
- **Keep the console open:** don't minimize the console window during the show, because browsers slow down hidden windows. Put the display window on the second screen instead.
- **Compatibility:** the Host and Join apps share `shared/protocol.js`. If you change one copy, update both.
- **First load needs internet:** the first time, the app downloads PeerJS, the QR library and fonts. After that they are cached.
