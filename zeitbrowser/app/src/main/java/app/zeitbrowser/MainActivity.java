package app.zeitbrowser;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.text.Html;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public class MainActivity extends Activity {

    static final String EXTRA_BLOCKED = "blocked";
    private static final String START = "zeitbrowser://start";
    private static final String GUARD = "zeitbrowser://guard";
    private static final String PAUSE_MEDIA_JS =
            "document.querySelectorAll('video,audio').forEach(function(m){m.pause();});";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Set<String> warned = new HashSet<>();

    private Limits limits;
    private WebView web;
    private EditText bar;
    private TextView banner;
    private FrameLayout root;
    private LinearLayout content;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private boolean running;
    private boolean clearHistoryWhenLoaded;
    private boolean onStartPage;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            onTick();
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        limits = new Limits(this);
        buildUi();
        setupWeb();
        if (handleBlockedIntent(getIntent())) return;
        if (savedInstanceState != null && web.restoreState(savedInstanceState) != null) return;
        showStart();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleBlockedIntent(intent);
    }

    /** Der Waechter hat uns aus einer anderen App heraus geoeffnet. */
    private boolean handleBlockedIntent(Intent intent) {
        String d = intent == null ? null : intent.getStringExtra(EXTRA_BLOCKED);
        if (d == null) return false;
        intent.removeExtra(EXTRA_BLOCKED);
        stopOtherMedia();
        showBlocked(d);
        return true;
    }

    /** Audio-Fokus holen: Brave und die YouTube-App halten dann ihr Video an. */
    private void stopOtherMedia() {
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (am == null) return;
        AudioFocusRequest req = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                        .build())
                .setOnAudioFocusChangeListener(change -> { })
                .build();
        am.requestAudioFocus(req);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void buildUi() {
        root = new FrameLayout(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setBackgroundColor(Color.WHITE);

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(6), dp(4), dp(6), dp(4));

        Button home = new Button(this);
        home.setText("⌂");
        home.setOnClickListener(v -> showStart());
        top.addView(home, new LinearLayout.LayoutParams(dp(48), ViewGroup.LayoutParams.WRAP_CONTENT));

        bar = new EditText(this);
        bar.setSingleLine(true);
        bar.setHint("Adresse oder Suche");
        bar.setInputType(EditorInfo.TYPE_CLASS_TEXT | EditorInfo.TYPE_TEXT_VARIATION_URI);
        bar.setImeOptions(EditorInfo.IME_ACTION_GO);
        bar.setSelectAllOnFocus(true);
        bar.setOnEditorActionListener((v, actionId, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                    && event.getAction() == KeyEvent.ACTION_DOWN;
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                go(bar.getText().toString());
                return true;
            }
            return false;
        });
        top.addView(bar, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button settings = new Button(this);
        settings.setText("⏱");
        settings.setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
        top.addView(settings, new LinearLayout.LayoutParams(dp(48), ViewGroup.LayoutParams.WRAP_CONTENT));

        banner = new TextView(this);
        banner.setTextColor(Color.WHITE);
        banner.setTextSize(14);
        banner.setGravity(Gravity.CENTER);
        banner.setPadding(dp(8), dp(4), dp(8), dp(4));
        banner.setVisibility(View.GONE);

        web = new WebView(this);

        content.addView(top);
        content.addView(banner);
        content.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(content);
        setContentView(root);
    }

    private void setupWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if (START.equals(uri.toString())) {
                    showStart();
                    return true;
                }
                if (GUARD.equals(uri.toString())) {
                    startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS));
                    return true;
                }
                // Keine Spruenge in andere Apps (z. B. YouTube-App), damit nichts am Limit vorbei laeuft.
                if (!"http".equals(scheme) && !"https".equals(scheme)) return true;
                String d = limits.match(uri.getHost());
                if (d != null && limits.remainingSeconds(d) <= 0) {
                    showBlocked(d);
                    return true;
                }
                return false;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (url != null && url.startsWith("http")) onStartPage = false;
                updateBar(url);
                checkBlocked(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Nach der Sperrseite fuehrt "Zurueck" nicht wieder auf die gesperrte Seite.
                if (clearHistoryWhenLoaded) {
                    clearHistoryWhenLoaded = false;
                    view.clearHistory();
                }
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                updateBar(url);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreenView = view;
                fullscreenCallback = callback;
                content.setVisibility(View.GONE);
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });
    }

    private void exitFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        content.setVisibility(View.VISIBLE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
    }

    private void go(String input) {
        String text = input.trim();
        if (text.isEmpty()) return;
        String url;
        if (text.startsWith("http://") || text.startsWith("https://")) {
            url = text;
        } else if (!text.contains(" ") && text.contains(".")) {
            url = "https://" + text;
        } else {
            url = "https://search.brave.com/search?q=" + Uri.encode(text);
        }
        bar.clearFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(bar.getWindowToken(), 0);

        String d = limits.match(Uri.parse(url).getHost());
        if (d != null && limits.remainingSeconds(d) <= 0) {
            showBlocked(d);
            return;
        }
        web.loadUrl(url);
    }

    private void updateBar(String url) {
        if (bar.hasFocus() || url == null) return;
        if (url.startsWith("http")) bar.setText(url);
        else bar.setText("");
    }

    private void checkBlocked(String url) {
        if (url == null || !url.startsWith("http")) return;
        String d = limits.match(Uri.parse(url).getHost());
        if (d != null && limits.remainingSeconds(d) <= 0) showBlocked(d);
    }

    /** Jede Sekunde: Zeit auf limitierter Seite zaehlen, warnen, sperren. */
    private void onTick() {
        String url = web.getUrl();
        String d = (url != null && url.startsWith("http")) ? limits.match(Uri.parse(url).getHost()) : null;
        if (d == null) {
            banner.setVisibility(View.GONE);
            return;
        }
        int rest = limits.remainingSeconds(d);
        if (rest <= 0) {
            showBlocked(d);
            return;
        }
        limits.addSecond(d);
        rest--;

        banner.setVisibility(View.VISIBLE);
        banner.setText(d + ": noch " + Limits.formatTime(rest) + " heute");
        banner.setBackgroundColor(rest <= Limits.WARN_SECONDS ? Color.rgb(200, 60, 50) : Color.rgb(31, 42, 68));

        String today = Limits.today();
        if (rest <= Limits.WARN_SECONDS && warned.add(today + d + "5")) {
            warn("Noch " + Math.max(1, (rest + 59) / 60) + " Minuten auf " + d + ".");
        }
        if (rest <= 60 && warned.add(today + d + "1")) {
            warn("Letzte Minute auf " + d + ".");
        }
        if (rest == 0) showBlocked(d);
    }

    private void warn(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        Vibrator vib = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (vib != null && vib.hasVibrator()) {
            vib.vibrate(VibrationEffect.createOneShot(400, VibrationEffect.DEFAULT_AMPLITUDE));
        }
    }

    private void showBlocked(String domain) {
        exitFullscreen();
        web.evaluateJavascript(PAUSE_MEDIA_JS, null);
        web.stopLoading();
        banner.setVisibility(View.GONE);
        onStartPage = false;
        String html = page(
                "<div class='big'>⏱</div>"
                        + "<h1>Zeit aufgebraucht</h1>"
                        + "<p>Deine " + limits.all().get(domain) + " Minuten für <b>" + Html.escapeHtml(domain)
                        + "</b> sind für heute vorbei.</p>"
                        + "<p>Ab morgen geht es wieder.</p>"
                        + "<p><a href='" + START + "'>Zur Startseite</a></p>");
        clearHistoryWhenLoaded = true;
        web.loadDataWithBaseURL("about:blank", html, "text/html", "utf-8", null);
        updateBar("");
    }

    private void showStart() {
        exitFullscreen();
        onStartPage = true;
        StringBuilder rows = new StringBuilder();
        for (Map.Entry<String, Integer> e : limits.all().entrySet()) {
            String d = e.getKey();
            int rest = limits.remainingSeconds(d);
            String esc = Html.escapeHtml(d);
            rows.append("<a class='row' href='https://").append(esc).append("'>")
                    .append("<span>").append(esc).append("</span>")
                    .append("<span class='").append(rest > 0 ? "ok" : "off").append("'>")
                    .append(rest > 0 ? "noch " + Limits.formatTime(rest) : "für heute gesperrt")
                    .append(" von ").append(e.getValue()).append(" Min.</span></a>");
        }
        if (rows.length() == 0) rows.append("<p>Noch keine Limits. Tippe oben auf ⏱.</p>");
        String guard = GuardService.isEnabled(this)
                ? "<p class='ok'>✓ Wächter aktiv: gilt auch in Brave und der YouTube-App.</p>"
                : "<a class='row warn' href='" + GUARD + "'><span><b>Wächter ist aus.</b> Brave und die YouTube-App "
                + "sind dann nicht begrenzt. Tippen zum Einschalten: Bedienungshilfen, ZeitBrowser Wächter.</span></a>";
        String html = page("<h1>ZeitBrowser</h1>" + guard + "<p class='sub'>Heute übrig:</p>" + rows
                + "<p class='hint'>Seiten ohne Limit kannst du oben ganz normal eingeben.</p>");
        web.loadDataWithBaseURL("about:blank", html, "text/html", "utf-8", null);
        updateBar("");
    }

    private static String page(String body) {
        return "<!doctype html><html><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{font-family:sans-serif;margin:0;padding:24px 16px;color:#1f2a44;background:#f6f5f2}"
                + "h1{font-size:24px;margin:8px 0}.sub{color:#666}.big{font-size:64px;text-align:center}"
                + ".row{display:flex;justify-content:space-between;gap:12px;padding:14px;margin:8px 0;background:#fff;"
                + "border-radius:12px;text-decoration:none;color:inherit;box-shadow:0 1px 3px rgba(0,0,0,.08)}"
                + ".ok{color:#2e7d32}.warn{background:#fdecea;color:#8a1c12}.off{color:#c0392b}.hint{color:#888;font-size:14px;margin-top:24px}"
                + "a{color:#1f5fbf}</style></head><body>" + body + "</body></html>";
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        if (!running) {
            running = true;
            handler.post(tick);
        }
        String url = web.getUrl();
        if (url == null || !url.startsWith("http")) {
            // Startseite neu zeichnen, falls sich Limits oder der Waechter geaendert haben.
            if (onStartPage) showStart();
        } else {
            checkBlocked(url);
        }
    }

    @Override
    protected void onPause() {
        running = false;
        handler.removeCallbacks(tick);
        // Video anhalten, sonst laeuft es im Hintergrund weiter, ohne dass gezaehlt wird.
        web.evaluateJavascript(PAUSE_MEDIA_JS, null);
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (fullscreenView != null) {
            exitFullscreen();
        } else if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
