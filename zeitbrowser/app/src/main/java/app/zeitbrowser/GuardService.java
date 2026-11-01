package app.zeitbrowser;

import android.accessibilityservice.AccessibilityService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Toast;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Waechter: zaehlt limitierte Seiten auch in anderen Browsern und in der YouTube-App.
 * Alle Wege teilen sich dasselbe Tagesbudget.
 */
public class GuardService extends AccessibilityService {

    /** Browser-Paket zu ID der Adressleiste. */
    private static final Map<String, String> BROWSERS = new HashMap<>();
    /** Apps, die fest zu einer Domain gehoeren. */
    private static final Map<String, String> APPS = new HashMap<>();

    static {
        BROWSERS.put("com.brave.browser", "com.brave.browser:id/url_bar");
        BROWSERS.put("com.brave.browser_beta", "com.brave.browser_beta:id/url_bar");
        BROWSERS.put("com.brave.browser_nightly", "com.brave.browser_nightly:id/url_bar");
        BROWSERS.put("com.android.chrome", "com.android.chrome:id/url_bar");
        BROWSERS.put("com.chrome.beta", "com.chrome.beta:id/url_bar");
        BROWSERS.put("com.microsoft.emmx", "com.microsoft.emmx:id/url_bar");
        BROWSERS.put("com.sec.android.app.sbrowser", "com.sec.android.app.sbrowser:id/location_bar_edit_text");
        BROWSERS.put("org.mozilla.firefox", "org.mozilla.firefox:id/mozac_browser_toolbar_url_view");
        BROWSERS.put("org.mozilla.focus", "org.mozilla.focus:id/mozac_browser_toolbar_url_view");
        BROWSERS.put("com.duckduckgo.mobile.android", "com.duckduckgo.mobile.android:id/omnibarTextInput");
        BROWSERS.put("com.opera.browser", "com.opera.browser:id/url_field");
        BROWSERS.put("com.vivaldi.browser", "com.vivaldi.browser:id/url_bar");
        BROWSERS.put("com.kiwibrowser.browser", "com.kiwibrowser.browser:id/url_bar");

        APPS.put("com.google.android.youtube", "youtube.com");
        APPS.put("com.google.android.apps.youtube.music", "youtube.com");
        APPS.put("com.instagram.android", "instagram.com");
        APPS.put("com.zhiliaoapp.musically", "tiktok.com");
        APPS.put("com.facebook.katana", "facebook.com");
        APPS.put("com.twitter.android", "x.com");
        APPS.put("com.reddit.frontpage", "reddit.com");
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Set<String> warned = new HashSet<>();
    /** Letzte bekannte Domain pro Browser, falls die Adressleiste ausgeblendet ist (Vollbild-Video). */
    private final Map<String, String> lastHost = new HashMap<>();
    private Limits limits;
    private long lastKick;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            try {
                onTick();
            } catch (RuntimeException ignored) {
                // Nie abstuerzen, sonst schaltet Android den Waechter ab.
            }
            handler.postDelayed(this, 1000);
        }
    };

    static boolean isEnabled(Context context) {
        String enabled = Settings.Secure.getString(context.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (enabled == null) return false;
        ComponentName me = new ComponentName(context, GuardService.class);
        for (String s : enabled.split(":")) {
            ComponentName c = ComponentName.unflattenFromString(s);
            if (me.equals(c)) return true;
        }
        return false;
    }

    @Override
    protected void onServiceConnected() {
        limits = new Limits(this);
        handler.removeCallbacks(tick);
        handler.post(tick);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Alles passiert im Sekundentakt in onTick.
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        super.onDestroy();
    }

    private void onTick() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null && !pm.isInteractive()) return;

        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || root.getPackageName() == null) return;
        String pkg = root.getPackageName().toString();
        if (pkg.equals(getPackageName())) return; // ZeitBrowser zaehlt selbst

        String domain = null;
        String app = APPS.get(pkg);
        if (app != null) {
            domain = limits.match(app);
        } else {
            String barId = BROWSERS.get(pkg);
            if (barId == null) return;
            String host = readHost(root, barId);
            if (host != null) lastHost.put(pkg, host);
            else host = lastHost.get(pkg);
            domain = limits.match(host);
        }
        if (domain == null) return;

        int rest = limits.remainingSeconds(domain);
        if (rest <= 0) {
            kick(domain);
            return;
        }
        limits.addSecond(domain);
        rest--;

        String today = Limits.today();
        if (rest <= Limits.WARN_SECONDS && warned.add(today + domain + "5")) {
            warn("Noch " + Math.max(1, (rest + 59) / 60) + " Minuten auf " + domain + ".");
        }
        if (rest <= 60 && warned.add(today + domain + "1")) {
            warn("Letzte Minute auf " + domain + ".");
        }
        if (rest == 0) kick(domain);
    }

    private static String readHost(AccessibilityNodeInfo root, String viewId) {
        List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByViewId(viewId);
        if (nodes == null || nodes.isEmpty() || nodes.get(0).getText() == null) return null;
        String t = nodes.get(0).getText().toString().trim().toLowerCase(Locale.ROOT);
        if (t.isEmpty() || t.contains(" ")) return null; // Suchbegriff wird gerade getippt
        if (t.startsWith("https://")) t = t.substring(8);
        if (t.startsWith("http://")) t = t.substring(7);
        int cut = t.length();
        for (char c : new char[]{'/', '?', '#', ':'}) {
            int i = t.indexOf(c);
            if (i >= 0 && i < cut) cut = i;
        }
        t = t.substring(0, cut);
        return t.contains(".") ? t : null;
    }

    /** Sperrseite im ZeitBrowser nach vorne holen. Die stoppt auch das Video in der anderen App. */
    private void kick(String domain) {
        long now = System.currentTimeMillis();
        if (now - lastKick < 1500) return;
        lastKick = now;
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra(MainActivity.EXTRA_BLOCKED, domain);
        startActivity(i);
    }

    private void warn(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        Vibrator vib = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (vib != null && vib.hasVibrator()) {
            vib.vibrate(VibrationEffect.createOneShot(400, VibrationEffect.DEFAULT_AMPLITUDE));
        }
    }
}
