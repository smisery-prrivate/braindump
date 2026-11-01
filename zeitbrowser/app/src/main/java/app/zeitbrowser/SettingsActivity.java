package app.zeitbrowser;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.Map;

/** Limits pro Domain anlegen, aendern, loeschen. */
public class SettingsActivity extends Activity {

    private Limits limits;
    private LinearLayout list;
    private Button guardBtn;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        limits = new Limits(this);

        ScrollView scroll = new ScrollView(this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(16), dp(16), dp(16), dp(16));
        col.setBackgroundColor(Color.rgb(246, 245, 242));
        scroll.addView(col);

        col.addView(text("Tageslimits", 24, true));
        col.addView(text("Senken und neue Limits wirken sofort. Erhöhen und Löschen wirken erst ab morgen, "
                + "damit du dich nicht im Moment selbst austrickst.", 14, false));

        guardBtn = new Button(this);
        guardBtn.setOnClickListener(v -> startActivity(
                new android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        col.addView(guardBtn);

        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(0, dp(12), 0, dp(12));
        col.addView(list);

        col.addView(text("Neue Seite", 18, true));
        LinearLayout add = new LinearLayout(this);
        add.setOrientation(LinearLayout.HORIZONTAL);
        add.setGravity(Gravity.CENTER_VERTICAL);
        EditText domain = new EditText(this);
        domain.setHint("z. B. instagram.com");
        domain.setSingleLine(true);
        domain.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        add.addView(domain, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        EditText minutes = new EditText(this);
        minutes.setHint("Min.");
        minutes.setInputType(InputType.TYPE_CLASS_NUMBER);
        add.addView(minutes, new LinearLayout.LayoutParams(dp(72), ViewGroup.LayoutParams.WRAP_CONTENT));
        Button addBtn = new Button(this);
        addBtn.setText("+");
        addBtn.setOnClickListener(v -> {
            String d = Limits.normalize(domain.getText().toString());
            Integer m = parseMinutes(minutes.getText().toString());
            if (d.isEmpty() || !d.contains(".") || m == null) {
                Toast.makeText(this, "Bitte Domain und Minuten eingeben.", Toast.LENGTH_SHORT).show();
                return;
            }
            report(limits.set(d, m));
            domain.setText("");
            minutes.setText("");
            refresh();
        });
        add.addView(addBtn);
        col.addView(add);

        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private void refresh() {
        guardBtn.setText(GuardService.isEnabled(this)
                ? "Wächter aktiv (Brave, YouTube-App)"
                : "Wächter einschalten (sonst gilt das Limit nicht in Brave)");
        list.removeAllViews();
        Map<String, Integer> all = limits.all();
        Map<String, Integer> pending = limits.pending();
        if (all.isEmpty()) list.addView(text("Keine Limits gesetzt.", 14, false));
        for (Map.Entry<String, Integer> e : all.entrySet()) {
            String d = e.getKey();
            int used = limits.usedSeconds(d) / 60;
            String info = d + "\n" + e.getValue() + " Min. pro Tag, heute genutzt: " + used + " Min.";
            Integer p = pending.get(d);
            if (p != null) info += p < 0 ? "\nWird morgen gelöscht." : "\nAb morgen: " + p + " Min.";

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setBackgroundColor(Color.WHITE);
            row.setPadding(dp(12), dp(8), dp(8), dp(8));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.setMargins(0, dp(4), 0, dp(4));

            row.addView(text(info, 15, false), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            Button edit = new Button(this);
            edit.setText("Ändern");
            edit.setOnClickListener(v -> editDialog(d, e.getValue()));
            row.addView(edit);

            if (p != null) {
                Button undo = new Button(this);
                undo.setText("Zurück");
                undo.setOnClickListener(v -> {
                    limits.cancelPending(d);
                    refresh();
                });
                row.addView(undo);
            } else {
                Button del = new Button(this);
                del.setText("✕");
                del.setOnClickListener(v -> {
                    limits.remove(d);
                    Toast.makeText(this, "Wird ab morgen gelöscht.", Toast.LENGTH_SHORT).show();
                    refresh();
                });
                row.addView(del);
            }
            list.addView(row, lp);
        }
    }

    private void editDialog(String domain, int current) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_NUMBER);
        input.setText(String.valueOf(current));
        input.setSelectAllOnFocus(true);
        new AlertDialog.Builder(this)
                .setTitle(domain + ": Minuten pro Tag")
                .setView(input)
                .setPositiveButton("Speichern", (dlg, w) -> {
                    Integer m = parseMinutes(input.getText().toString());
                    if (m == null) return;
                    report(limits.set(domain, m));
                    refresh();
                })
                .setNegativeButton("Abbrechen", null)
                .show();
    }

    private void report(boolean now) {
        Toast.makeText(this, now ? "Gilt ab sofort." : "Gilt ab morgen.", Toast.LENGTH_SHORT).show();
    }

    private static Integer parseMinutes(String s) {
        try {
            int m = Integer.parseInt(s.trim());
            return (m >= 0 && m <= 24 * 60) ? m : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private TextView text(String s, int size, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(size);
        t.setTextColor(Color.rgb(31, 42, 68));
        if (bold) t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        t.setPadding(0, dp(4), 0, dp(4));
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
