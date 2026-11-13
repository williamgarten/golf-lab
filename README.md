# Golf Lab

Free, private golf practice web app. **Phase 2 (putting) is built first:** film a putt
from directly above, tap the ball and the hole, and it tells you how many degrees
left/right the ball started vs. your aim line, where that line reaches the hole,
where the ball finished, ball speed off the face, pace, and the green's Stimp reading.
With two bright stickers on the putter head (toe + heel) it also measures the stroke:
straight back vs. arc (inches inside at the top and follow-through, with a magnified
top-down chart), path at impact (in-to-out / out-to-in), face angle at address / top /
impact, and tempo (backstroke : forward time). The app has a camera setup guide (height
table, level, mount, sticker placement) and tells you after each putt how much of the line
the picture covered.

**Film in normal video at 1080p 60 fps** (Settings > Camera > Record Video). Slo-mo isn't
needed, and iPhone hands browsers a slowed-down copy of slo-mo clips, which would make
speeds read 4-8x too slow (there's a Settings switch for it if you do use slo-mo).

- Plain HTML/JS, no build step, no libraries, no server code.
- Videos never leave the phone. Only the numbers are saved (localStorage, on that phone).
- Works offline once opened (service worker). "Add to Home Screen" in Safari to make it look like an app.

## Run it on your Mac

```bash
python3 -m http.server 8790 --directory ~/golf-lab
```

Open http://localhost:8790. Click **Try the demo putt**, tap the ball, tap the hole, Analyze.

To try it on your iPhone on the same Wi-Fi: open `http://<your-Mac's-IP>:8790` in Safari.
(Offline mode / install only works once it's on an https host — see below.)

## Put it online for free (when you're ready)

Any static host works: GitHub Pages, Netlify, Vercel or Firebase Hosting. Upload the
folder as-is. No API keys, nothing to pay for.

## How it works

| File | Job |
|---|---|
| `js/tracker.js` | Finds the white ball (bright + unsaturated pixels) and the dark hole near a tap |
| `js/follow.js` | Steps through the video, waits for the stroke, follows the ball frame by frame |
| `js/stroke.js` | Follows the putter stickers (by colour) at 60 samples/s, then: takeaway (from how the head speeds up out of address), top, impact (from the ball), arc inside/outside, path at impact (curve fit), face angle (toe-heel line, averaged around impact), tempo |
| `js/analysis.js` | Start angle (first ~16 in of roll), miss at the hole, finish position. Scale comes from the ball's known size (42.67 mm). Speed: curve fit to the first positions, backed up to the moment of impact. Green speed: skips the first ~1 ft (skid), fits the steady slowdown `a` of the rolling ball, Stimp = 1.83² / (2a) m (a Stimpmeter releases the ball at 6 ft/s) |
| `js/app.js` | Screens, taps, drawing, replay, history |
| `js/store.js` | localStorage on the phone |

## Test

```bash
node tools/test-tracker.mjs
```

Generates 7 synthetic overhead putts (ball skid-then-roll + a putter with toe/heel stickers
on a known arc, face angle and tempo; straight, slight arc, strong arc, outside, one sticker,
no stickers, close-up with the hole off screen) and checks every number against the truth.
Latest run, all passing: angle within 0.05°, speed 1-3% low, Stimp within 0.2,
backstroke/through within 0.4 cm, inside-at-top within 0.1 cm, path within 0.25°,
face at impact within 0.2°, tempo 2.01 (one slow-stroke case 1.87) for a true 2.0.
`node tools/make-demo.mjs key=value ...` makes one test video + a .json of the true answers
(see the top of that file for the options).

## Known limits / next ideas

- Assumes the phone is roughly straight overhead. A tilted phone skews angles.
- Green speed assumes a flat putt. Uphill reads slow, downhill fast: hit putts both ways and use the
  History tab's average. Needs ~3 ft of clean roll in the picture.
- The skid model and ball-edge threshold were tuned on synthetic video; real footage may need a
  small calibration (compare once against a real Stimpmeter reading).
- Not yet tested on real iPhone footage — first real-world check to do.
- Face-angle accuracy depends on how big the stickers look: at the recommended 4 ft it's within
  ~0.3°; from much higher (stickers only a few pixels) it can be off by ~0.5-1°.
- The stroke is measured in 2D from above; a tilted phone or a putter shaft leaning a lot
  can skew face angle slightly.
- Next: the swing tab (MediaPipe pose).
