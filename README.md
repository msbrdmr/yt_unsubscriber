# YouTube Bulk Unsubscriber

Chrome extension that fetches every channel you're subscribed to on YouTube and unsubscribes from them in parallel. Built because the YouTube UI only lets you unsubscribe one at a time and the page is paginated, which is unusable if you have thousands of subs.

It talks to YouTube's own internal API (the same one the website uses) instead of clicking buttons in the DOM, so it's fast.

## Install

It's not on the Chrome Web Store. Load it unpacked:

1. Open `chrome://extensions`
2. Turn on "Developer mode" (top right)
3. Click "Load unpacked"
4. Pick this folder (the one with `manifest.json` in it)

The extension icon will show up in the toolbar. Pin it if you want.

## Use it

1. Make sure you're signed in to youtube.com in the same Chrome profile.
2. Click the extension icon. If you don't already have a YouTube tab open, it will open one in the background.
3. Click "Fetch subscriptions". It pages through your subscription list and counts up as it goes. With ~3000 subs this takes about a minute.
4. Click "Download CSV backup" if you want a record of which channels you were subscribed to before nuking the list. The CSV has the channel id and title.
5. Click "Unsubscribe from ALL". Confirm the prompt. Watch the progress bar.

The "Concurrency" field controls how many unsubscribe requests run at once. Default is 8. Higher is faster but more likely to get rate-limited by YouTube. If you see failures piling up, lower it and re-run; only channels that failed will be retried (successful ones get removed from the list).

You can close the popup while it's running. The work keeps going inside the YouTube tab. Open the popup again to see progress.

## Files

- `manifest.json` - extension manifest
- `popup.html` / `popup.css` / `popup.js` - the small UI
- `inject.js` - runs inside youtube.com, does the actual API calls

## How it works (briefly)

The popup uses `chrome.scripting.executeScript` to inject `inject.js` into the YouTube tab in the page's main world, where `window.ytcfg` is available. From there it:

- Builds the `SAPISIDHASH` auth header from the `SAPISID` cookie (this is what YouTube's own JS does).
- Calls `POST /youtubei/v1/browse` with `browseId: "FEchannels"` to get the first page of subscriptions, then follows the continuation token for each next page.
- For each channel, it pulls the `unsubscribeEndpoint` (channelIds + params) straight out of the response so the unsubscribe call is byte-for-byte what the YouTube UI would send.
- Runs `POST /youtubei/v1/subscription/unsubscribe` in parallel workers, with retries on transient errors.

## Things that can go wrong

- "No SAPISID cookie": you're not signed in, or you're signed in but in a different profile. Sign in on youtube.com in the same Chrome profile, reload the YouTube tab, then click the icon again.
- "INNERTUBE_CONTEXT unavailable": the YouTube tab hasn't finished loading, or you're on a non-www page. Open https://www.youtube.com/ and try again.
- A burst of failures: you've been rate-limited. Wait a minute, lower concurrency, and run again. Only the ones that failed will be retried.
- 0 subscriptions found after fetch: YouTube probably changed their response structure. Open the YouTube tab's devtools, look at the response of the `browse` call, and update the field names in `inject.js`.

## Not safe

You can't undo this. Download the CSV first if you might want the list later.
