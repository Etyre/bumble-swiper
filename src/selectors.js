// Everything the bot uses to recognise Bumble's Android screens lives here.
// Labels are matched against a node's content-description or text; ids against its resource-id.
// Use "Inspect page" on the dashboard to see the actual labels on your version of the app.

export const BUTTONS = {
  like: { label: /^(like|yes|heart|love|swipe right)$/i, id: /like|vote_yes|_yes\b|heart/i },
  pass: { label: /^(pass|no|nope|dislike|skip|swipe left|x)$/i, id: /pass|dislike|vote_no|_no\b|skip/i },
};

// Bottom navigation entry for the swipe screen.
export const NAV_PATTERNS = { encounters: /^(encounters|discover|people|home|swipe|date)$/i };

// Buttons with exactly this text (case-insensitive) are safe to tap to dismiss popups.
export const DISMISS_BUTTON_TEXTS = [
  'continue', 'keep swiping', 'continue swiping', 'back to swiping', 'not now', 'maybe later',
  'no thanks', 'no, thanks', 'close', 'got it', 'ok', 'okay', 'skip', 'dismiss', 'done', 'later',
];

export const MATCH_PATTERNS = [/it.?s a match/i, /you.?ve matched/i, /you matched with/i, /new match/i];

export const OUT_OF_SWIPES_PATTERNS = [
  /out of (likes|swipes|votes)/i,
  /reached your (daily )?(limit|max)/i,
  /no more (likes|swipes)/i,
  /come back (later|tomorrow|in)/i,
  /you.?re all caught up/i,
];

export const LOGGED_OUT_PATTERNS = [
  /use cell phone number/i, /use phone number/i, /continue with (facebook|google|apple)/i,
  /^(log in|sign in|sign up|create account)$/im, /welcome to bumble/i,
];
