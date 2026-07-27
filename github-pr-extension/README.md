# GitHub PR Dashboard (Chrome extension)

The popup uses a **GitHub-style light list** (grouped cards, PR metadata, state, pin/dismiss). Scopes are unchanged from below.

Small Chrome extension that shows:

1. **My open PRs** — pull requests you authored (`is:pr is:open author:@me` in the Search API).
2. **Review & mentions** — open PRs with `review-requested:@me`, `mentions:@me`, plus **`team-review-requested:org/slug`** for each team returned by [`GET /user/teams`](https://docs.github.com/en/rest/teams/teams#list-teams-for-the-authenticated-user). Add scope **`read:org`** (classic PAT) or organization team membership read (fine-grained) if team-based reviews never appear. If the inbox looks empty, try **Settings → Clear all dismissed PRs** in case everything was dismissed locally.

**Dismiss** on any card (My PRs, Review & mentions, or Pinned) hides that PR in this extension (stored in `chrome.storage.local` as `dismissedInboxUrls`). Dismissing also **unpins** the PR if it was pinned. Nothing changes on GitHub. Use **Settings → Clear all dismissed PRs** to show them again.

Each section uses a **collapsible** header (chevron in a square, title, count pill). Cards show title, metadata (`owner/repo #n · @creator`), a **state** line (open/draft, review/mention/team context on the inbox list, comment count when there are comments), **Pin** / **Pinned**, and **Dismiss** on every PR row.

On popup open, the last successful fetch is shown from a **local cache** immediately while lists **refresh** in the background. **Pinned** PRs appear in their own section (order preserved); pin URLs persist in `chrome.storage.local`. Settings can clear dismissed or pinned entries.

### PR Files changed — Tests last

On `https://github.com/{owner}/{repo}/pull/{n}/changes` (GitHub’s current Files changed UI), a **Tests last** checkbox appears beside the **All commits** dropdown. When enabled (default):

- The native file tree is hidden and replaced by extension-owned **Code** / **Tests** nested mirror trees (folders expandable, files link to diffs). GitHub’s React tree reverts DOM moves, so we do not relocate its nodes.
- Diff panels are sorted with CSS flex `order` (code first, tests last) without moving React-owned nodes.
- Test rows and diffs get a subtle amber tint; code rows/diffs get a subtle blue accent.
- Hover the toggle for a status tooltip (`tree ok`, file count, diff count).

Detection uses common paths: `tests/`, `__tests__/`, `test_*.py`, `*_test.py`, `.test.ts`, `.spec.js`, `conftest.py`, etc. The preference is stored in `chrome.storage.local` as `testsToBottomEnabled`.

## Setup

### Option A — OAuth (recommended)

1. Create a [GitHub OAuth app](https://github.com/settings/developers) (type: **OAuth app**).
   - **Homepage URL** (application URL): anything valid you’re OK showing on the app’s GitHub page — e.g. this repo, your profile, or `https://localhost`. Sign-in does **not** open this URL for device flow.
   - **Authorization callback URL**: still required on the form, but **device flow does not use it** (users authorize at `github.com/login/device` with a code). Use a harmless placeholder such as `https://localhost` or the same URL as the homepage. This extension does not implement the web redirect OAuth callback.
2. In the OAuth app settings, enable **Device authorization** (required for the [device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)).
3. In Chrome: **Extensions** → **Developer mode** → **Load unpacked** → select the `github-pr-extension` folder.
4. Open **Settings** from the popup, paste the app’s **Client ID**, click **Save Client ID**, then **Sign in with GitHub**. Open the GitHub device page, enter the code shown, and wait until Settings confirms success.
5. Open the toolbar popup and **Refresh** to load lists.

OAuth uses scopes **`repo`** and **`read:org`** (same intent as the PAT setup below). The access token is stored in **`chrome.storage.local`** on this device only (not sync).

### Option B — Personal access token

1. Create a [GitHub personal access token](https://github.com/settings/personal-access-tokens) with **`repo`** (private repos) or **`public_repo`** (public only), plus **`read:org`** when you need org team reviews.

2. Load the unpacked extension as above.

3. In **Settings**, paste the token under “personal access token” and **Save token**.

4. **Refresh** in the popup. If both OAuth and a PAT are set, **OAuth wins** until you **Disconnect GitHub**.

## Organization / private repos

GitHub hides organization and team context from the API when the token cannot see it. That often looks like an **empty “Review & mentions”** list even though you expect org PRs or **team** review requests.

- **Classic PAT**: use **`repo`** (private repos) and **`read:org`**. `read:org` is required for the [`/user/teams`](https://docs.github.com/en/rest/teams#list-teams-for-the-authenticated-user) call this extension uses to build `team-review-requested:` searches. Without it, GitHub returns **403** and team-based review requests never appear in the inbox.
- **Fine-grained PAT**: grant **access to the organization** (or the right repositories) and include **Pull requests** (and **Metadata** as needed) on those repos so search can return org PRs.
- **SAML SSO organizations**: after choosing scopes, you must **[authorize the personal access token for SSO](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/authorizing-a-personal-access-token-for-use-with-saml-single-sign-on)** for each org in GitHub’s UI, or API calls stay blocked for that org.

The popup may show a short **non-error** hint when the inbox is empty but the extension detects a likely scope issue (for example `/user/teams` returned 403, search `incomplete_results`, or you have open PRs under an org but no inbox hits).

## Limits

- Uses the GitHub [Search API](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests) (first page only, up to 40 items per query). If you exceed that often, we can add pagination later.
- “Mentions” follows GitHub’s search index for the `mentions:@me` qualifier (not every comment edge case).
- GitHub.com only (not Enterprise host).

## Files

- `manifest.json` — MV3 manifest, `storage` + `https://api.github.com/*` + `https://github.com/*` (OAuth device flow)
- `content/pr-changes-tests-bottom.js` — Tests-last toggle and DOM reorder on PR Files changed
- `content/pr-changes-tests-bottom.css` — Section labels and subtle code/test tinting
- `github-auth.js` — OAuth device flow + unified `getGithubAccessToken()` (OAuth then PAT)
- `popup.*` — UI and fetch logic
- `options.*` — token and clear-dismissed
- `icons/` — PNG toolbar icons (16/32/48/128); regenerate with `python3 scripts/generate-icons.py` (requires Pillow)
