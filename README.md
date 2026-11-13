# Golf Lab

**Open it: https://williamgarten.github.io/golf-lab/** — on iPhone, Safari → Share →
**Add to Home Screen** to use it like an app (works offline after the first visit).

Free, private golf practice web app.

**Live mode (Set up & record a putt):** live camera with a "place ball here" circle, a
"putt this way" arrow and a bubble level from the phone's tilt sensor. It talks you through
the setup (you can't see the screen with the phone overhead), records by itself once the
phone is level and still and the ball is in the circle, stops after the ball rolls away,
then finds the ball and putter stickers itself and analyzes with no taps. **Putter line-up
monitor:** with the toe/heel stickers on, it checks the putter at address (head centred behind
the ball, 2-10 cm back, face within 1.5° of square to the putt line, held still) and coaches
("Face is open. Square it up", "Slide the putter a little left") until it can say "Lined up. Go
ahead." It only talks while the putter is held still, never mid-stroke, and the moment you
lined up is used to find the stickers in the analysis. **Check the level**
runs the two-reading test (reading, turn 180°, reading) to find and correct the sensor's own
error. `?fakecam=test/live.mp4` lets a video stand in for the camera when testing on a computer.

 **Wedges: clock drills.** Film yourself face-on (tripod ~10 ft in front, phone sideways, waist
high). The body tracker (MediaPipe Pose, Google's free open-source model, runs on the phone; ~10 MB
downloaded once, then cached offline) finds your lead arm, the clock hand: down = 6:00, level = 9:00,
up = 12:00. Through is counted as a mirror image ("9 to 9" = level both sides). A live session
watches every swing with no taps, says "Back 9:15, 10 minutes long. Through 9, right on", shows the
top and finish with the clock drawn on, and saves each swing. Type the carry and it builds your
yardage chart per club and drill (average and ± spread, counting only on-target swings), plus how
often you hit the positions. Tempo is shown as approximate (±0.4 at 30 fps). Checks: phone straight
(sideways lean, from the motion sensor), whole body in the picture, facing the camera, hands
together at address. `?fakepose=1` (or `=fast`) runs a made-up session for testing on a computer.

**Phase 2 (putting) is built first:** film a putt
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

## Hosting

Hosted free on GitHub Pages from the `main` branch. Push to `main` and the site updates
in about a minute; the app checks for the new version each time it opens.

## How it works

| File | Job |
|---|---|
| `js/tracker.js` | Finds the white ball (bright + unsaturated pixels) and the dark hole near a tap |
| `js/follow.js` | Steps through the video, waits for the stroke, follows the ball frame by frame |
| `js/stroke.js` | Follows the putter stickers (by colour) at 60 samples/s, then: takeaway (from how the head speeds up out of address), top, impact (from the ball), arc inside/outside, path at impact (curve fit), face angle (toe-heel line, averaged around impact), tempo |
| `js/analysis.js` | Start angle (first ~16 in of roll), miss at the hole, finish position. Scale comes from the ball's known size (42.67 mm). Speed: curve fit to the first positions, backed up to the moment of impact. Green speed: skips the first ~1 ft (skid), fits the steady slowdown `a` of the rolling ball, Stimp = 1.83² / (2a) m (a Stimpmeter releases the ball at 6 ft/s) |
| `js/app.js` | Screens, taps, drawing, replay, history |
| `js/capture.js` | Live putting camera: ball circle, level, putter line-up, voice, auto-record |
| `js/pose.js` | Loads MediaPipe Pose (pinned 0.10.14, full model) and runs it on a frame |
| `js/clock.js` | Wedge clock maths: lead-arm angle, top / impact / finish, clock positions, tempo |
| `js/wedges.js` | Wedges tab: live clock-drill session, video upload, yardage chart |
| `js/store.js` | localStorage on the phone |

## Test

```bash
node tools/test-tracker.mjs
node tools/test-clock.mjs
```

`test-clock.mjs` checks 6 fake swings (7:30, 9, 10:30, full past 12, left-handed, choppy 15 fps)
plus a waggle that must not count: positions within 2° (3° at noisy 15 fps), tempo within 0.5.

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
- Wedges: not yet tried on a real person's video — body-tracker accuracy on real swings is the
  first thing to check. The facing-the-camera check (shoulder width vs torso) is a guess to tune.
