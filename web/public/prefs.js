/*
 * Theme and language, applied before first paint.
 *
 * A classic, render-blocking script on purpose. The app bundle is a module,
 * and module scripts are deferred: the browser may paint the dark default
 * before main.ts runs, so a light-theme or Arabic reader would see a flash
 * of the wrong page. The CSP forbids inline scripts, so this lives here as
 * a same-origin file, the one file in web/ that Vite does not bundle.
 *
 * It must stay tiny and must never throw: storage can be blocked (private
 * windows, disabled cookies), and the page has to render without it. The
 * keys and values mirror web/src/prefs/theme.ts and lang.ts, which own the
 * toggles once the app has loaded.
 */
(function () {
	var root = document.documentElement;
	var theme = null;
	var lang = null;
	try {
		theme = window.localStorage.getItem("eleen.theme");
		lang = window.localStorage.getItem("eleen.lang");
	} catch (e) {
		/* Storage unavailable: follow the system, keep the HTML's language. */
	}
	if (theme !== "light" && theme !== "dark") {
		var light = false;
		try {
			light = window.matchMedia("(prefers-color-scheme: light)").matches;
		} catch (e) {
			/* No matchMedia: dark, the default. */
		}
		theme = light ? "light" : "dark";
	}
	root.setAttribute("data-theme", theme);
	if (lang === "ar" || lang === "en") {
		root.lang = lang;
		root.dir = lang === "ar" ? "rtl" : "ltr";
	}
})();
