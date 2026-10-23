# Picture Frame driver for Hubitat

A Hubitat device driver that controls the picture frame and its TV over the frame's HTTP API. Photo, favorite and play/pause changes reach the hub instantly through the frame's live event stream (`/api/events`), so rules and dashboards stay in sync with the frame.

## Install

1. **Drivers Code → New Driver**. Paste [`picture-frame-driver.groovy`](picture-frame-driver.groovy) and click **Save**. If the GitHub repo is public, you can use **Import** with the `importUrl` instead.
2. **Devices → Add Device → Virtual**. Name it (for example "Picture Frame"), choose Type **Picture Frame**, and save.
3. In the device's **Preferences**, set:
   - **Frame IP address**: for example `192.168.5.121`.
   - **Port**: `3000`.
   - **Auth secret**: only if `auth.enabled` is on in the frame's config.
   - **Check TV power every**: how often to poll the TV's on/off state.
4. Click **Save Preferences**. The **eventStream** attribute should change to `connected`.

The hub must be able to reach the frame. If the hub is on a different subnet, check that routing allows hub → frame.

## Commands

| Command | Does |
|---|---|
| **On / Off** (Switch) | Turns the TV on or off (`/api/tv/on`, `/api/tv/off`) |
| **Play / Pause / Stop** (MediaTransport) | Starts or pauses the slideshow. Stop is the same as pause |
| Next Photo / Previous Photo | Steps the slideshow |
| Toggle Play Pause | Play if paused, pause if playing |
| Shuffle | A brand-new random order, starting now. Every photo shows once before any repeats. Switches the frame to Sequential mode |
| Unshuffle | Back to the normal order |
| Toggle Favorite | Favorites or unfavorites the photo on screen |
| Delete Photo | Deletes the photo on screen. **Off until you enable it in preferences**. It takes effect immediately, and the file moves to the frame's `data/deleted/` folder |
| Show Favorites / Show All Photos / Toggle Favorites Only | Turns the favorites-only filter on or off |
| Set Slide Interval | 5, 10, 15, 30, 60 or 300 seconds |
| Set Slideshow Mode | sequential, random, smart, artistic |
| Set Slideshow Order | date, filename, thisday. Choosing one turns shuffle off |
| TV Toggle | TV on if it's off, off if it's on |
| TV Key | Sends any remote key (volume, inputs, D-pad, …) |
| Reconnect | Reopens the live event stream |
| Refresh | Re-reads the photo, slideshow state and TV power |

## Buttons (PushableButton)

For Pico/button remotes, dashboards and Button Controller rules:

| Button | Action |
|---|---|
| 1 | Next photo |
| 2 | Previous photo |
| 3 | Play/pause slideshow |
| 4 | Toggle favorite |
| 5 | Toggle favorites-only |
| 6 | Toggle TV power |
| 7 | Shuffle into a new order |

Delete is deliberately not mapped to a button.

## Attributes

| Attribute | Example |
|---|---|
| `switch` | `on` / `off`. The TV's power |
| `tvPower` | `on`, `standby`, `unreachable`, `unknown` |
| `transportStatus` | `playing` / `paused` |
| `photoId`, `photoName`, `photoDate`, `photoLocation` | The photo on screen |
| `photoFavorite` | `true` / `false` |
| `photoUrl` | Direct URL to the current photo |
| `photoTile` | An HTML `<img>` tag, so an **Attribute** dashboard tile shows the current photo |
| `favoritesOnly` | `on` / `off` |
| `shuffle` | `on` / `off` |
| `slideshowMode`, `slideshowOrder`, `slideInterval` | Current slideshow settings |
| `eventStream` | `connected` / `disconnected` |

## Example rules

- **Morning and night:** at 7:00 turn the Picture Frame **on**, and at 23:00 turn it **off**. This drives the TV through the frame.
- **Nobody home:** when presence changes to *away*, turn it **off**. When someone arrives, turn it **on**.
- **Favorites in the evening:** at sunset, run **Show Favorites**. At bedtime, run **Show All Photos**.
- **Pico remote:** with Button Controller, map buttons 1 to 4 to the device's buttons 1 to 4.
- **Fresh order every morning:** at 7:00, run **Shuffle**.

## Notes

- The frame has to be on the same subnet as the TV for TV control to work. See "TV Power Control" in the main README.
- If the event stream drops (for example when the frame restarts), the driver reconnects with increasing back-off, up to every 5 minutes. It also refreshes every 30 minutes as a safety net.
