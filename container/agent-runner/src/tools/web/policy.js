const DEFAULT_RESTRICTED_DOMAINS = [
    'linkedin.com',
    'www.linkedin.com',
    'm.linkedin.com',
];
const CHALLENGE_MARKERS_STRONG = [
    'captcha',
    'unusual traffic',
    'our systems have detected unusual traffic',
    'access denied',
    'confirm this search was made by a human',
    'please solve the challenge below',
    'one last step',
    'select all squares containing',
    'challenge required',
];
const CHALLENGE_MARKERS_WEAK = [
    'verify you are human',
    'bot detection',
    'bots use duckduckgo too',
    'please enable javascript',
    'sign in to continue',
    'login required',
];
function toHostname(value) {
    try {
        const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
        return new URL(withProtocol).hostname.toLowerCase();
    }
    catch {
        return value.trim().toLowerCase();
    }
}
export function getRestrictedDomains(secrets) {
    const raw = secrets?.WEB_RESTRICTED_DOMAINS?.trim();
    if (!raw)
        return DEFAULT_RESTRICTED_DOMAINS;
    return raw
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
}
export function isRestrictedUrl(url, restrictedDomains) {
    const host = toHostname(url);
    return restrictedDomains.some((domain) => {
        const d = toHostname(domain);
        return host === d || host.endsWith(`.${d}`);
    });
}
export function looksLikeChallengePage(text) {
    const hay = text.toLowerCase();
    if (CHALLENGE_MARKERS_STRONG.some((marker) => hay.includes(marker))) {
        return true;
    }
    let weakHits = 0;
    for (const marker of CHALLENGE_MARKERS_WEAK) {
        if (hay.includes(marker))
            weakHits += 1;
        if (weakHits >= 2)
            return true;
    }
    return false;
}
//# sourceMappingURL=policy.js.map