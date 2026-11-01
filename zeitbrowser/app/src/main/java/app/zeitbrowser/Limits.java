package app.zeitbrowser;

import android.content.Context;
import android.content.SharedPreferences;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Tageslimits pro Domain und die heute schon genutzte Zeit.
 *
 * Gegen Schummeln: Ein Limit senken oder neu anlegen wirkt sofort.
 * Ein Limit erhoehen oder loeschen wirkt erst ab dem naechsten Tag.
 */
final class Limits {

    static final int WARN_SECONDS = 5 * 60;

    private static final String KEY_LIMITS = "limits";
    private static final String KEY_PENDING = "pending";
    private static final String KEY_PENDING_DATE = "pendingDate";

    private final SharedPreferences prefs;

    Limits(Context context) {
        prefs = context.getSharedPreferences("zeit", Context.MODE_PRIVATE);
        if (!prefs.contains(KEY_LIMITS)) {
            prefs.edit().putString(KEY_LIMITS, "youtube.com=10").apply();
        }
        applyPending();
        cleanOldUsage();
    }

    static String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    static String normalize(String domain) {
        String d = domain.trim().toLowerCase(Locale.ROOT);
        if (d.startsWith("https://")) d = d.substring(8);
        if (d.startsWith("http://")) d = d.substring(7);
        int slash = d.indexOf('/');
        if (slash >= 0) d = d.substring(0, slash);
        if (d.startsWith("www.")) d = d.substring(4);
        if (d.startsWith("m.")) d = d.substring(2);
        return d;
    }

    /** Alle aktiven Limits: Domain zu Minuten pro Tag. */
    Map<String, Integer> all() {
        applyPending();
        return parse(prefs.getString(KEY_LIMITS, ""));
    }

    /** Geplante Aenderungen ab morgen. Wert -1 bedeutet loeschen. */
    Map<String, Integer> pending() {
        return parse(prefs.getString(KEY_PENDING, ""));
    }

    /** Gibt true zurueck, wenn die Aenderung sofort gilt, false wenn erst ab morgen. */
    boolean set(String domain, int minutes) {
        String d = normalize(domain);
        Map<String, Integer> limits = all();
        Integer current = limits.get(d);
        if (current == null || minutes <= current) {
            limits.put(d, minutes);
            Map<String, Integer> pend = pending();
            pend.remove(d);
            prefs.edit()
                    .putString(KEY_LIMITS, join(limits))
                    .putString(KEY_PENDING, join(pend))
                    .apply();
            return true;
        }
        schedule(d, minutes);
        return false;
    }

    void remove(String domain) {
        schedule(normalize(domain), -1);
    }

    void cancelPending(String domain) {
        Map<String, Integer> pend = pending();
        pend.remove(normalize(domain));
        prefs.edit().putString(KEY_PENDING, join(pend)).apply();
    }

    /** Welche limitierte Domain passt zu diesem Host? null wenn keine. */
    String match(String host) {
        if (host == null) return null;
        String h = host.toLowerCase(Locale.ROOT);
        for (String d : all().keySet()) {
            if (h.equals(d) || h.endsWith("." + d)) return d;
        }
        return null;
    }

    int usedSeconds(String domain) {
        return prefs.getInt(usageKey(domain), 0);
    }

    void addSecond(String domain) {
        prefs.edit().putInt(usageKey(domain), usedSeconds(domain) + 1).apply();
    }

    /** Verbleibende Sekunden heute. Integer.MAX_VALUE wenn kein Limit. */
    int remainingSeconds(String domain) {
        Integer limit = all().get(domain);
        if (limit == null) return Integer.MAX_VALUE;
        return Math.max(0, limit * 60 - usedSeconds(domain));
    }

    private String usageKey(String domain) {
        return "used_" + today() + "_" + domain;
    }

    private void schedule(String domain, int minutes) {
        Map<String, Integer> pend = pending();
        pend.put(domain, minutes);
        prefs.edit()
                .putString(KEY_PENDING, join(pend))
                .putString(KEY_PENDING_DATE, today())
                .apply();
    }

    private void applyPending() {
        String date = prefs.getString(KEY_PENDING_DATE, "");
        if (date.isEmpty() || date.compareTo(today()) >= 0) return;
        Map<String, Integer> limits = parse(prefs.getString(KEY_LIMITS, ""));
        for (Map.Entry<String, Integer> e : parse(prefs.getString(KEY_PENDING, "")).entrySet()) {
            if (e.getValue() < 0) limits.remove(e.getKey());
            else limits.put(e.getKey(), e.getValue());
        }
        prefs.edit()
                .putString(KEY_LIMITS, join(limits))
                .remove(KEY_PENDING)
                .remove(KEY_PENDING_DATE)
                .apply();
    }

    private void cleanOldUsage() {
        String prefix = "used_" + today() + "_";
        List<String> old = new ArrayList<>();
        for (String key : prefs.getAll().keySet()) {
            if (key.startsWith("used_") && !key.startsWith(prefix)) old.add(key);
        }
        if (old.isEmpty()) return;
        SharedPreferences.Editor ed = prefs.edit();
        for (String key : old) ed.remove(key);
        ed.apply();
    }

    private static Map<String, Integer> parse(String s) {
        Map<String, Integer> map = new LinkedHashMap<>();
        if (s == null || s.isEmpty()) return map;
        for (String part : s.split(";")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            try {
                map.put(part.substring(0, eq), Integer.parseInt(part.substring(eq + 1)));
            } catch (NumberFormatException ignored) {
            }
        }
        return map;
    }

    private static String join(Map<String, Integer> map) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, Integer> e : map.entrySet()) {
            if (sb.length() > 0) sb.append(';');
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.toString();
    }

    static String formatTime(int seconds) {
        return String.format(Locale.GERMANY, "%d:%02d", seconds / 60, seconds % 60);
    }
}
