package com.gongxiangjia.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * 安卓版悬浮球：
 * 平时不显示；电脑发来文件/文字时浮出来，点一下复制/下载，点右侧打开主界面。
 */
public class BallService extends Service {

    static final String PREFS = "gxj";
    private static final String CHANNEL = "gxj_ball";
    private static final int NOTI_ID = 7711;

    private WindowManager wm;
    private FrameLayout root;
    private WindowManager.LayoutParams lp;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private LinearLayout pill;
    private FrameLayout circle;
    private ImageView iconView;
    private TextView badge;
    private TextView openBtn;

    private volatile boolean alive = true;
    private Thread sseThread;
    private SharedPreferences sp;

    private boolean expanded = false;
    private boolean shown = false;
    private boolean waiting = false;        // 有未读内容（角标亮着）
    private View panelRoot;
    private boolean panelShown = false;
    private boolean peek = true;              // 贴边只露一小条
    private Runnable retractTask;
    private NodeServer node;
    private Discovery discovery;
    private View tabRoot;                     // 贴边的小条
    private int tabY = 0;
    private Uri lastSavedUri = null;
    private long lastTapAt = 0;
    private int tabX = 0;
    private boolean tabShown = false;
    private Runnable autoHide;
    private Runnable collapseTask;

    private String kind = "file";
    private String name = "";
    private String text = "";
    private String path = "";

    private long seenTextMtime = 0;
    private String seenFileTop = "";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private int downX, downY;
    private float touchX, touchY;
    private boolean dragging = false;
    private long downAt = 0;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        startForegroundCompat();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        acquireLocks();
        buildBall();
        if (sp.getBoolean("ball_always", true)) ui.post(this::showIdleBall);
        startNode();
        startSse();
        startPoll();
        startWatchdog();
    }

    /** 尽量别让系统在锁屏后把连接掐掉 */
    private void acquireLocks() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gxj:ball");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
        } catch (Exception ignored) {}
        try {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wifi != null) {
                wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "gxj:ball");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        } catch (Exception ignored) {}
    }

    private void startForegroundCompat() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26 && nm != null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "悬浮球待命",
                        NotificationManager.IMPORTANCE_MIN);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
            Intent open = new Intent(this, MainActivity.class);
            PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL)
                    : new Notification.Builder(this);
            b.setContentTitle("共享夹")
                    .setContentText("悬浮球待命中 · 收到文件会弹出来")
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentIntent(pi)
                    .setOngoing(true);
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTI_ID, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTI_ID, b.build());
            }
        } catch (Exception e) {
            Log.d("GXJ", "foreground err " + e);
        }
    }

    // ---------------- 悬浮球界面 ----------------

    private void buildBall() {
        int size = dp(54);
        int pad = dp(8);

        root = new FrameLayout(this);

        pill = new LinearLayout(this);
        pill.setOrientation(LinearLayout.HORIZONTAL);
        pill.setGravity(Gravity.CENTER_VERTICAL);
        pill.setPadding(pad, pad, pad, pad);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#F2FFFFFF"));
        bg.setCornerRadius(dp(30));
        bg.setStroke(dp(1), Color.parseColor("#1A0F172A"));
        pill.setBackground(bg);
        pill.setElevation(dp(10));

        circle = new FrameLayout(this);
        GradientDrawable cbg = new GradientDrawable();
        cbg.setShape(GradientDrawable.OVAL);
        cbg.setColor(Color.parseColor("#2563EB"));
        circle.setBackground(cbg);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(dp(40), dp(40));
        circle.setLayoutParams(clp);

        iconView = new ImageView(this);
        iconView.setImageResource(R.mipmap.ic_launcher);
        FrameLayout.LayoutParams ilp = new FrameLayout.LayoutParams(dp(28), dp(28), Gravity.CENTER);
        circle.addView(iconView, ilp);

        badge = new TextView(this);
        badge.setTextSize(10);
        badge.setTextColor(Color.WHITE);
        badge.setTypeface(badge.getTypeface(), Typeface.BOLD);
        badge.setGravity(Gravity.CENTER);
        GradientDrawable bbg = new GradientDrawable();
        bbg.setShape(GradientDrawable.OVAL);
        bbg.setColor(Color.parseColor("#F97316"));
        badge.setBackground(bbg);
        badge.setText("1");
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(dp(17), dp(17), Gravity.TOP | Gravity.END);
        blp.rightMargin = -dp(3);
        blp.topMargin = -dp(3);
        circle.addView(badge, blp);

        pill.addView(circle);

        openBtn = new TextView(this);
        openBtn.setText("打开");
        openBtn.setTextSize(12.5f);
        openBtn.setTextColor(Color.WHITE);
        openBtn.setTypeface(Typeface.DEFAULT_BOLD);
        openBtn.setGravity(Gravity.CENTER);
        GradientDrawable obg = new GradientDrawable();
        obg.setCornerRadius(dp(14));
        obg.setColor(Color.parseColor("#2563EB"));
        openBtn.setBackground(obg);
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(dp(52), dp(34));
        olp.leftMargin = dp(7);
        openBtn.setLayoutParams(olp);
        openBtn.setVisibility(View.GONE);
        pill.addView(openBtn);

        buildTab();

        root.addView(pill, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT));

        // 整个浮窗自己吃事件：避免点到球时把下面的图标也点开
        root.setOnDragListener(dropListener);
        root.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = lp.x;
                        downY = lp.y;
                        touchX = e.getRawX();
                        touchY = e.getRawY();
                        dragging = false;
                        downAt = System.currentTimeMillis();
                        break;
                    case MotionEvent.ACTION_MOVE: {
                        int dx = (int) (e.getRawX() - touchX);
                        int dy = (int) (e.getRawY() - touchY);
                        if (Math.abs(dx) > dp(3) || Math.abs(dy) > dp(4)) dragging = true;
                        if (dragging && peek) {
                            // 往外拉才把它拉出来
                            boolean inward = downX > 0 ? dx < -dp(4) : dx > dp(4);
                            if (inward) peek = false;
                            else break;
                        }
                        if (dragging) {
                            if (panelShown) hidePanel();
                            cancelRetract();
                            lp.x = downX + dx;
                            lp.y = downY + dy;
                            try { wm.updateViewLayout(root, lp); } catch (Exception ignored) {}
                        }
                        break;
                    }
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL: {
                        if (dragging) {
                            int w = getResources().getDisplayMetrics().widthPixels;
                            if (lp.x <= dp(6) || lp.x >= w - dp(60)) { goPeek(); break; }
                            snapToEdge();
                            pullOut();
                            break;
                        }
                        long held = System.currentTimeMillis() - downAt;
                        if (held > 650) { openApp(); break; }
                        if (peek) { pullOut(); break; }
                        if (expanded && hitOpen(e)) { openApp(); break; }
                        long now2 = System.currentTimeMillis();
                        if (now2 - lastTapAt < 320) { lastTapAt = 0; openApp(); break; }
                        lastTapAt = now2;
                        ui.postDelayed(() -> {
                            if (lastTapAt != now2) return;
                            lastTapAt = 0;
                            if (waiting) act(); else onBallTap();
                        }, 300);
                        break;
                    }
                }
                return true;
            }
        });

        lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                Build.VERSION.SDK_INT >= 26
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = getResources().getDisplayMetrics().widthPixels - dp(74);
        lp.y = getResources().getDisplayMetrics().heightPixels / 2;
    }

    private void buildTab() {
        FrameLayout tab = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#D92563EB"));
        float r = dp(8);
        bg.setCornerRadii(new float[]{r, r, 0, 0, 0, 0, r, r});
        tab.setBackground(bg);

        View grip = new View(this);
        GradientDrawable gb = new GradientDrawable();
        gb.setColor(Color.parseColor("#B3FFFFFF"));
        gb.setCornerRadius(dp(2));
        FrameLayout.LayoutParams glp = new FrameLayout.LayoutParams(dp(3), dp(20), Gravity.CENTER);
        grip.setBackground(gb);
        tab.addView(grip, glp);

        tab.setOnDragListener(dropListener);
        tab.setOnClickListener(v -> pullOut());
        tab.setOnTouchListener(new View.OnTouchListener() {
            float sx = 0;
            @Override
            public boolean onTouch(View v, MotionEvent e) {
                if (e.getActionMasked() == MotionEvent.ACTION_DOWN) sx = e.getRawX();
                if (e.getActionMasked() == MotionEvent.ACTION_MOVE && Math.abs(e.getRawX() - sx) > dp(5)) {
                    pullOut();
                    return true;
                }
                return false;
            }
        });
        tabRoot = tab;
    }

    /** 文件拖到小条/球上：直接发到电脑，不打开 App */
    private final View.OnDragListener dropListener = (v, event) -> {
        switch (event.getAction()) {
            case android.view.DragEvent.ACTION_DRAG_STARTED:
                return true;
            case android.view.DragEvent.ACTION_DRAG_ENTERED:
                toast("松手就发到电脑");
                try { v.animate().scaleX(1.1f).scaleY(1.1f).setDuration(120).start(); } catch (Exception ignored) {}
                return true;
            case android.view.DragEvent.ACTION_DRAG_EXITED:
                try { v.animate().scaleX(1f).scaleY(1f).setDuration(120).start(); } catch (Exception ignored) {}
                return true;
            case android.view.DragEvent.ACTION_DROP: {
                try { v.animate().scaleX(1f).scaleY(1f).setDuration(100).start(); } catch (Exception ignored) {}
                android.content.ClipData cd = event.getClipData();
                if (cd == null || cd.getItemCount() == 0) return true;
                String droppedText = null;
                java.util.List<Uri> list = new java.util.ArrayList<>();
                for (int i = 0; i < cd.getItemCount(); i++) {
                    android.content.ClipData.Item it = cd.getItemAt(i);
                    if (it.getUri() != null) list.add(it.getUri());
                    else if (it.getText() != null && droppedText == null) droppedText = it.getText().toString();
                }
                if (!list.isEmpty()) {
                    sendUrisToPc(list);
                } else if (droppedText != null && !droppedText.trim().isEmpty()) {
                    final String body = droppedText;
                    toast("正在发送文字…");
                    new Thread(() -> {
                        boolean ok = postTextToPc(body);
                        toast(ok ? "已发送文字到电脑" : "文字发送失败");
                        if (ok) ui.post(() -> { hideTab(); swallowPulse(); ui.postDelayed(this::goPeek, 700); });
                    }).start();
                } else {
                    toast("没识别到内容");
                }
                return true;
            }
        }
        return true;
    };

    private void sendUrisToPc(final java.util.List<Uri> uris) {
        toast("正在发送 " + uris.size() + " 个文件…");
        new Thread(() -> {
            int ok = 0;
            for (Uri u : uris) if (uploadUri(u)) ok++;
            final int n = ok, total = uris.size();
            toast(n == total ? "已发送到电脑 · " + n + " 个" : "发送了 " + n + "/" + total);
            if (n > 0) ui.post(() -> {
                hideTab();
                waiting = false;
                badge.setVisibility(View.GONE);
                collapse();
                swallowPulse();
                ui.postDelayed(this::goPeek, 700);
            });
        }).start();
    }

    private boolean uploadUri(Uri uri) {
        HttpURLConnection conn = null;
        try {
            String name = uri.getLastPathSegment();
            try {
                android.database.Cursor c = getContentResolver().query(uri, null, null, null, null);
                if (c != null) {
                    int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0 && c.moveToFirst()) name = c.getString(idx);
                    c.close();
                }
            } catch (Exception ignored) {}
            if (name == null || name.isEmpty()) name = "从手机拖入";
            String token = Uri.parse(sp.getString("web_url", "")).getQueryParameter("t");
            String url = baseUrl() + "/api/upload?name=" + URLEncoder.encode(name, "UTF-8")
                    + "&t=" + URLEncoder.encode(token == null ? "" : token, "UTF-8");
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(120000);
            conn.setRequestProperty("Content-Type", "application/octet-stream");
            InputStream in = getContentResolver().openInputStream(uri);
            if (in == null) return false;
            OutputStream out = conn.getOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush(); out.close(); in.close();
            int code = conn.getResponseCode();
            if (code == 200) {
                try {
                    BufferedReader br2 = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = br2.readLine()) != null) sb.append(line);
                    br2.close();
                    org.json.JSONObject o = new org.json.JSONObject(sb.toString());
                    String saved = o.optString("name");
                    if (!saved.isEmpty()) sp.edit().putString("seen_file", saved).apply();
                } catch (Exception ignored) {}
            }
            return code == 200;
        } catch (Exception e) {
            Log.d("GXJ", "drop upload err " + e);
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 吞掉文件时的动画：球体缩一下再弹回 */
    private void swallowPulse() {
        try {
            root.animate().scaleX(0.86f).scaleY(0.86f).setDuration(110)
                    .withEndAction(() -> root.animate().scaleX(1f).scaleY(1f).setDuration(220).start())
                    .start();
        } catch (Exception ignored) {}
    }

    private void expand() {
        expanded = true;
        // 展开后要保证整条胶囊都在屏幕内（贴右边缘时先往左让出空间）
        int w = getResources().getDisplayMetrics().widthPixels;
        int wide = dp(126);
        int targetX = (lp.x + dp(27) > w / 2) ? (w - wide) : dp(6);
        lp.x = Math.max(dp(4), targetX);
        try { wm.updateViewLayout(root, lp); } catch (Exception ignored) {}
        openBtn.setVisibility(View.VISIBLE);
        openBtn.setAlpha(0f);
        openBtn.animate().alpha(1f).setDuration(140).start();
        if (collapseTask != null) ui.removeCallbacks(collapseTask);
        collapseTask = () -> { if (expanded) collapse(); };
        ui.postDelayed(collapseTask, 6000);
    }

    private void collapse() {
        expanded = false;
        openBtn.setVisibility(View.GONE);
        snapToEdge();
    }

    private boolean hitOpen(MotionEvent e) {
        try {
            if (openBtn == null || openBtn.getVisibility() != View.VISIBLE) return false;
            int[] loc = new int[2];
            openBtn.getLocationOnScreen(loc);
            float x = e.getRawX();
            float y = e.getRawY();
            return x >= loc[0] - dp(8) && x <= loc[0] + openBtn.getWidth() + dp(8)
                    && y >= loc[1] - dp(8) && y <= loc[1] + openBtn.getHeight() + dp(8);
        } catch (Exception ex) { return false; }
    }

    private void snapToEdge() {
        int w = getResources().getDisplayMetrics().widthPixels;
        int target = (lp.x + dp(27) < w / 2) ? dp(6) : w - dp(66);
        lp.x = target;
        try { wm.updateViewLayout(root, lp); } catch (Exception ignored) {}
    }

    /** 平时常驻的小球（用来发送） */
    private void showIdleBall() {
        waiting = false;
        peek = true;
        if (shown) hideBallQuiet();
        showTab();
    }

    /** 贴边只露一小条的小矩形 */
    private void showTab() {
        if (tabShown || tabRoot == null) return;
        try {
            int w = getResources().getDisplayMetrics().widthPixels;
            WindowManager.LayoutParams tlp = new WindowManager.LayoutParams(
                    dp(14), dp(54),
                    Build.VERSION.SDK_INT >= 26
                            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                            : WindowManager.LayoutParams.TYPE_PHONE,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                    PixelFormat.TRANSLUCENT);
            tlp.gravity = Gravity.TOP | Gravity.START;
            tlp.x = (lp.x + dp(27) < w / 2) ? 0 : w - dp(14);
            tlp.y = Math.max(dp(40), lp.y + dp(70));
            wm.addView(tabRoot, tlp);
            tabShown = true;
            tabY = tlp.y;
            tabX = tlp.x;
        } catch (Exception ignored) {}
    }

    private void hideTab() {
        if (!tabShown || tabRoot == null) return;
        try { wm.removeView(tabRoot); } catch (Exception ignored) {}
        tabShown = false;
    }

    private void hideBallQuiet() {
        if (!shown) return;
        shown = false;
        try { wm.removeView(root); } catch (Exception ignored) {}
    }

    private void pullOut() {
        boolean wasPeek = peek;
        peek = false;
        int w = getResources().getDisplayMetrics().widthPixels;
        // 小条的中心和球对齐：不要往上/往下跳
        if (tabY > 0) lp.y = tabY - dp(70);
        hideTab();
        if (!shown) {
            try { wm.addView(root, lp); shown = true; } catch (Exception ignored) { return; }
        }
        lp.x = (lp.x + dp(27) < w / 2) ? dp(4) : w - dp(70);
        try { wm.updateViewLayout(root, lp); } catch (Exception ignored) {}
        root.setAlpha(1f);
        if (wasPeek) {
            root.setTranslationX((lp.x < w / 2 ? -1 : 1) * dp(26));
            root.setScaleX(0.82f);
            root.setScaleY(0.82f);
            root.animate().translationX(0).scaleX(1f).scaleY(1f).setDuration(190).start();
        }
        cancelRetract();
        retractTask = this::goPeek;
        ui.postDelayed(retractTask, 9000);
    }

    private void goPeek() {
        if (!sp.getBoolean("ball_always", true)) return;
        hidePanel();
        collapse();
        showIdleBall();
    }

    private void cancelRetract() {
        if (retractTask != null) { ui.removeCallbacks(retractTask); retractTask = null; }
    }

    /** 点球：有未读就先处理未读，否则弹出发送面板 */
    private void onBallTap() {
        cancelAutoHide();
        if (waiting) {
            if (!expanded) expand(); else act();
            return;
        }
        if (panelShown) hidePanel(); else showPanel();
    }

    private void showPanel() {
        try {
            if (panelRoot == null) buildPanel();
            WindowManager.LayoutParams plp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    Build.VERSION.SDK_INT >= 26
                            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                            : WindowManager.LayoutParams.TYPE_PHONE,
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT);
            plp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN;
            plp.gravity = Gravity.TOP | Gravity.START;
            int w = getResources().getDisplayMetrics().widthPixels;
            plp.x = Math.max(dp(8), w - dp(210));
            plp.y = Math.max(dp(60), lp.y - dp(70));
            wm.addView(panelRoot, plp);
            panelShown = true;
        } catch (Exception e) { Log.d("GXJ", "panel err " + e); }
    }

    private void hidePanel() {
        hideTextInput();
        if (!panelShown || panelRoot == null) return;
        try { wm.removeView(panelRoot); } catch (Exception ignored) {}
        panelShown = false;
    }

    private void buildPanel() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#FFFFFF"));
        bg.setCornerRadius(dp(18));
        bg.setStroke(dp(1), Color.parseColor("#140F172A"));
        card.setBackground(bg);
        card.setPadding(dp(8), dp(6), dp(8), dp(6));
        card.setElevation(dp(12));

        card.addView(panelRow("发送文件", v -> { hidePanel(); launchWith("send-file"); }));
        card.addView(panelRow("发送图片", v -> { hidePanel(); launchWith("send-photo"); }));
        card.addView(panelRow("发送文字…", v -> { hidePanel(); showTextInput(); }));
        card.addView(panelRow("发送最近的文件", v -> { hidePanel(); sendLatestAnything(); }));
        card.addView(panelRow("发送剪贴板", v -> { hidePanel(); sendClipboardDirect(); }));
        card.addView(panelRow("打开共享夹", v -> { hidePanel(); openApp(); }));

        panelRoot = card;
    }

    private TextView panelRow(String label, View.OnClickListener click) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextSize(13.5f);
        t.setTextColor(Color.parseColor("#0F172A"));
        t.setPadding(dp(14), dp(13), dp(22), dp(13));
        t.setOnClickListener(click);
        return t;
    }

    /** 发手机里最近的一个文件（图片、视频、文档都算，谁最新发谁） */
    private void sendLatestAnything() {
        Uri bestUri = null;
        String bestName = "";
        long bestAt = 0;

        // 1) 相册里最新的一张
        try {
            android.database.Cursor c = getContentResolver().query(
                    android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    new String[]{android.provider.MediaStore.Images.Media._ID,
                            android.provider.MediaStore.Images.Media.DISPLAY_NAME,
                            android.provider.MediaStore.Images.Media.DATE_ADDED},
                    null, null,
                    android.provider.MediaStore.Images.Media.DATE_ADDED + " DESC");
            if (c != null) {
                if (c.moveToFirst()) {
                    long at = c.getLong(2) * 1000L;
                    if (at > bestAt) {
                        bestAt = at;
                        bestName = c.getString(1);
                        bestUri = android.content.ContentUris.withAppendedId(
                                android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, c.getLong(0));
                    }
                }
                c.close();
            }
        } catch (Exception ignored) {}

        // 2) Download 里最新的文件
        try {
            File dir = new File(android.os.Environment.getExternalStorageDirectory(), "Download");
            File[] fs = dir.listFiles();
            if (fs != null) {
                for (File f : fs) {
                    if (!f.isFile() || f.getName().startsWith(".")) continue;
                    if (f.lastModified() > bestAt) { bestAt = f.lastModified(); bestName = f.getName(); bestUri = Uri.fromFile(f); }
                }
            }
        } catch (Exception ignored) {}

        if (bestUri == null) { launchWith("send-file"); return; }
        final Uri u = bestUri;
        final String n = bestName;
        toast("发送最近的文件 · " + n);
        new Thread(() -> {
            boolean ok = uploadUri(u);
            toast(ok ? "已发送到电脑 · " + n : "发送失败，试试手动选文件");
            if (!ok) launchWith("send-file");
            else ui.post(() -> { hideTab(); swallowPulse(); ui.postDelayed(this::goPeek, 700); });
        }).start();
    }

    /** 直接发最新一张照片（相册里最近保存/拍的） */
    private void sendLatestImage() {
        Uri uri = null;
        String name = "最新照片";
        try {
            android.database.Cursor c = getContentResolver().query(
                    android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    new String[]{android.provider.MediaStore.Images.Media._ID,
                            android.provider.MediaStore.Images.Media.DISPLAY_NAME},
                    null, null,
                    android.provider.MediaStore.Images.Media.DATE_ADDED + " DESC");
            if (c != null) {
                if (c.moveToFirst()) {
                    long id = c.getLong(0);
                    String dn = c.getString(1);
                    if (dn != null && !dn.isEmpty()) name = dn;
                    uri = android.content.ContentUris.withAppendedId(
                            android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
                }
                c.close();
            }
        } catch (Exception ignored) {}
        if (uri == null) {
            toast("读不到相册，去设置里给「照片和视频」权限");
            launchWith("send-photo");
            return;
        }
        final Uri u = uri;
        final String n = name;
        toast("发送最新照片 · " + n);
        new Thread(() -> {
            boolean ok = uploadUri(u);
            toast(ok ? "已发送到电脑 · " + n : "发送失败");
            if (ok) ui.post(() -> { hideTab(); swallowPulse(); ui.postDelayed(this::goPeek, 700); });
        }).start();
    }

    /** 直接发手机里最新保存的文件（Downloads 里最新的） */
    private void sendLatestFile() {
        Uri uri = null;
        String name = "最新文件";
        try {
            java.io.File dir = new java.io.File(android.os.Environment.getExternalStorageDirectory(), "Download");
            java.io.File best = null;
            java.io.File[] fs = dir.listFiles();
            if (fs != null) {
                for (java.io.File f : fs) {
                    if (!f.isFile()) continue;
                    if (best == null || f.lastModified() > best.lastModified()) best = f;
                }
            }
            if (best != null) { name = best.getName(); uri = Uri.fromFile(best); }
        } catch (Exception ignored) {}
        if (uri == null) { launchWith("send-file"); return; }
        final Uri u = uri;
        final String n = name;
        toast("发送最新文件 · " + n);
        new Thread(() -> {
            boolean ok = uploadUri(u);
            toast(ok ? "已发送到电脑 · " + n : "发送失败，试试手动选文件");
            if (!ok) launchWith("send-file");
            else ui.post(() -> { hideTab(); swallowPulse(); ui.postDelayed(this::goPeek, 700); });
        }).start();
    }

    /** 直接读剪贴板发出去（不打开 App） */
    private void sendClipboardDirect() {
        String text = "";
        try {
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm != null && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                CharSequence cs = cm.getPrimaryClip().getItemAt(0).coerceToText(this);
                if (cs != null) text = cs.toString();
            }
        } catch (Exception ignored) {}
        if (text.trim().isEmpty()) {
            toast("读不到剪贴板，打开 App 里发送");
            launchWith("send-clip");
            return;
        }
        final String body = text;
        toast("正在发送剪贴板…");
        new Thread(() -> {
            boolean ok = postTextToPc(body);
            toast(ok ? "已发送剪贴板到电脑" : "发送失败");
        }).start();
    }

    private boolean postTextToPc(String text) {
        HttpURLConnection conn = null;
        try {
            String token = Uri.parse(sp.getString("web_url", "")).getQueryParameter("t");
            String url = baseUrl() + "/api/text?t=" + URLEncoder.encode(token == null ? "" : token, "UTF-8");
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("Content-Type", "text/plain; charset=utf-8");
            OutputStream out = conn.getOutputStream();
            out.write(text.getBytes("UTF-8"));
            out.flush();
            out.close();
            return conn.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private View textPanel;
    private boolean textPanelShown = false;

    private void showTextInput() {
        try {
            if (textPanelShown) { hideTextInput(); return; }
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(Color.parseColor("#FFFFFF"));
            bg.setCornerRadius(dp(20));
            bg.setStroke(dp(1), Color.parseColor("#1A0F172A"));
            box.setBackground(bg);
            box.setPadding(dp(16), dp(14), dp(16), dp(12));
            box.setElevation(dp(14));

            TextView title = new TextView(this);
            title.setText("发送文字到电脑");
            title.setTextSize(14f);
            title.setTextColor(Color.parseColor("#0F172A"));
            box.addView(title);

            final EditText input = new EditText(this);
            input.setHint("输入或粘贴文字…");
            input.setTextSize(14f);
            input.setMinLines(3);
            input.setGravity(Gravity.TOP);
            input.setBackgroundColor(Color.parseColor("#F5F7FB"));
            input.setPadding(dp(12), dp(10), dp(12), dp(10));
            LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            ilp.topMargin = dp(10);
            box.addView(input, ilp);

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.END);

            TextView cancel = new TextView(this);
            cancel.setText("取消");
            cancel.setTextSize(13.5f);
            cancel.setTextColor(Color.parseColor("#64748B"));
            cancel.setPadding(dp(14), dp(10), dp(14), dp(10));
            cancel.setOnClickListener(v -> hideTextInput());

            TextView send = new TextView(this);
            send.setText("发送");
            send.setTextSize(13.5f);
            send.setTextColor(Color.WHITE);
            send.setPadding(dp(20), dp(10), dp(20), dp(10));
            GradientDrawable sbg = new GradientDrawable();
            sbg.setColor(Color.parseColor("#2563EB"));
            sbg.setCornerRadius(dp(12));
            send.setBackground(sbg);
            send.setOnClickListener(v -> {
                String t = input.getText() == null ? "" : input.getText().toString();
                if (t.trim().isEmpty()) { toast("先写点什么"); return; }
                hideTextInput();
                toast("正在发送文字…");
                final String body = t;
                new Thread(() -> {
                    boolean ok = postTextToPc(body);
                    toast(ok ? "已发送文字到电脑" : "发送失败");
                }).start();
            });

            LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rlp.topMargin = dp(8);
            row.addView(cancel);
            row.addView(send);
            box.addView(row, rlp);

            WindowManager.LayoutParams plp = new WindowManager.LayoutParams(
                    Math.min(getResources().getDisplayMetrics().widthPixels - dp(40), dp(330)),
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    Build.VERSION.SDK_INT >= 26
                            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                            : WindowManager.LayoutParams.TYPE_PHONE,
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT);
            plp.gravity = Gravity.CENTER;
            plp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                    | WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE;
            wm.addView(box, plp);
            textPanel = box;
            textPanelShown = true;
            input.requestFocus();
            input.postDelayed(() -> {
                try {
                    android.view.inputmethod.InputMethodManager imm =
                            (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                    if (imm != null) imm.showSoftInput(input, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
                } catch (Exception ignored) {}
            }, 350);
        } catch (Exception e) {
            Log.d("GXJ", "text panel err " + e);
            launchWith("send-clip");
        }
    }

    private void hideTextInput() {
        if (!textPanelShown || textPanel == null) return;
        try { wm.removeView(textPanel); } catch (Exception ignored) {}
        textPanelShown = false;
        textPanel = null;
    }

    private void launchWith(String action) {
        try {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            i.putExtra("gxj_action", action);
            i.putExtra("from_ball", true);
            startActivity(i);
        } catch (Exception e) { toast("打不开，请手动打开共享夹"); }
    }

    private void showBall(String newKind) {
        kind = newKind;
        if (root == null) return;
        if (!shown) {
            try {
                wm.addView(root, lp);
                shown = true;
                root.setAlpha(0f);
                root.setScaleX(0.7f);
                root.setScaleY(0.7f);
                root.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(240).start();
            } catch (Exception e) { Log.d("GXJ", "addView err " + e); }
        }
        waiting = true;
        peek = false;
        hideTab();
        badge.setVisibility(View.VISIBLE);
        root.setAlpha(1f);
        cancelRetract();
        int w = getResources().getDisplayMetrics().widthPixels;
        if (lp.x < 0 || lp.x > w - dp(30)) {
            lp.x = (lp.x < 0) ? dp(4) : w - dp(70);
            try { wm.updateViewLayout(root, lp); } catch (Exception ignored) {}
        }
        cancelAutoHide();
        autoHide = () -> hideBall();
        ui.postDelayed(autoHide, 22000);
    }

    private void hideBall() {
        hidePanel();
        hideTab();
        if (!shown || root == null) return;
        shown = false;
        expanded = false;
        openBtn.setVisibility(View.GONE);
        root.animate().alpha(0f).scaleX(0.7f).scaleY(0.7f).setDuration(180)
                .withEndAction(() -> {
                    try { wm.removeView(root); } catch (Exception ignored) {}
                }).start();
    }

    private void cancelAutoHide() {
        if (autoHide != null) { ui.removeCallbacks(autoHide); autoHide = null; }
    }

    // ---------------- 点击动作 ----------------

    private void act() {
        if ("localfile".equals(kind) || "file".equals(kind)) {
            try {
                android.content.ClipboardManager cm =
                        (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (lastSavedUri != null) {
                    android.content.ClipData clip = android.content.ClipData.newUri(
                            getContentResolver(), name, lastSavedUri);
                    cm.setPrimaryClip(clip);
                    toast("已复制文件 · " + name);
                } else {
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("共享夹", name));
                    toast("已复制文件名 · " + name);
                }
            } catch (Exception e) { toast("复制失败"); }
            waiting = false;
            badge.setVisibility(View.GONE);
            collapse();
            if (sp.getBoolean("ball_always", true)) ui.postDelayed(this::goPeek, 600);
            else hideBall();
            return;
        }
        if ("text".equals(kind)) {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("共享夹", text));
                toast("已复制文字");
            } catch (Exception e) { toast("复制失败"); }
        } else {
            toast("开始下载 · " + name);
            download(path, name);
        }
        waiting = false;
        badge.setVisibility(View.GONE);
        collapse();
        if (sp.getBoolean("ball_always", true)) ui.postDelayed(this::goPeek, 600);
        else hideBall();
    }

    private void openApp() {
        try {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
        } catch (Exception ignored) {}
        hideBall();
    }

    private void toast(final String msg) {
        ui.post(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }

    // ---------------- 下载 ----------------

    private String baseUrl() {
        try {
            Uri u = Uri.parse(sp.getString("web_url", ""));
            if (u.getHost() == null) return "";
            int port = u.getPort();
            return u.getScheme() + "://" + u.getHost() + (port > 0 ? ":" + port : "");
        } catch (Exception e) { return ""; }
    }

    private void download(final String rel, final String shownName) {
        new Thread(() -> {
            HttpURLConnection conn = null;
            File tmp = null;
            try {
                String token = Uri.parse(sp.getString("web_url", "")).getQueryParameter("t");
                String url = baseUrl() + "/api/file?p=" + URLEncoder.encode(rel, "UTF-8")
                        + "&t=" + URLEncoder.encode(token == null ? "" : token, "UTF-8");
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(60000);
                if (conn.getResponseCode() != 200) { toast("下载失败"); return; }
                String mime = conn.getContentType();
                tmp = new File(getCacheDir(), "ball-" + System.currentTimeMillis());
                InputStream in = conn.getInputStream();
                FileOutputStream out = new FileOutputStream(tmp);
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                out.flush(); out.close(); in.close();
                if (save(tmp, shownName, mime)) toast("已保存到 下载/共享夹 · " + shownName);
                else toast("保存失败");
            } catch (Exception e) {
                toast("下载失败：" + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
                if (tmp != null) tmp.delete();
            }
        }).start();
    }

    private boolean save(File src, String name, String mime) {
        String safe = (name == null || name.isEmpty()) ? "共享夹文件" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
        String type = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                v.put(MediaStore.MediaColumns.MIME_TYPE, type);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/共享夹");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri item = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (item == null) return false;
                OutputStream os = getContentResolver().openOutputStream(item);
                InputStream is = new FileInputStream(src);
                byte[] b = new byte[64 * 1024];
                int n;
                while ((n = is.read(b)) > 0) os.write(b, 0, n);
                os.flush(); os.close(); is.close();
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(item, done, null, null);
                lastSavedUri = item;
                return true;
            }
            File dir = new File(android.os.Environment.getExternalStoragePublicDirectory(
                    android.os.Environment.DIRECTORY_DOWNLOADS), "共享夹");
            if (!dir.exists() && !dir.mkdirs()) return false;
            File dest = new File(dir, safe);
            InputStream is = new FileInputStream(src);
            OutputStream os = new FileOutputStream(dest);
            byte[] b = new byte[64 * 1024];
            int n;
            while ((n = is.read(b)) > 0) os.write(b, 0, n);
            os.flush(); os.close(); is.close();
            return true;
        } catch (Exception e) {
            Log.d("GXJ", "ball save err " + e);
            return false;
        }
    }

    // ---------------- 接收推送 ----------------

    private void startSse() {
        sseThread = new Thread(() -> {
            while (alive) {
                HttpURLConnection conn = null;
                try {
                    String base = baseUrl();
                    String token = Uri.parse(sp.getString("web_url", "")).getQueryParameter("t");
                    if (base.isEmpty() || token == null) { Thread.sleep(5000); continue; }
                    String url = base + "/api/events?t=" + URLEncoder.encode(token, "UTF-8");
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(10000);
                    // 服务器每 20 秒发一次心跳；这里设 45 秒读超时，
                    // 这样网络断了会自己重连，而不是卡死在读上。
                    conn.setReadTimeout(45000);
                    conn.setRequestProperty("Accept", "text/event-stream");
                    BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
                    String line;
                    while (alive && (line = r.readLine()) != null) {
                        if (line.startsWith("data: ")) handleState(line.substring(6));
                    }
                } catch (java.net.SocketTimeoutException te) {
                    // 45 秒没心跳：当作断线，重连
                } catch (Exception e) {
                    // 断线就等一会儿重连
                } finally {
                    if (conn != null) conn.disconnect();
                }
                if (!alive) break;
                try { Thread.sleep(4000); } catch (InterruptedException e) { break; }
            }
        });
        sseThread.setDaemon(true);
        sseThread.start();
    }

    /** 手机自己也作为一个节点：别的设备可以直接发文件过来 */
    private void startNode() {
        try {
            node = new NodeServer(this);
            node.setOnFileIn((inName, inSize) -> {
                // 同时存一份到「下载/共享夹」，用户在文件管理器里能直接看到
                final File src = new File(node.root(), inName);
                ui.post(() -> {
                    boolean ok = save(src, inName, null);
                    kind = "localfile";
                    name = inName;
                    path = "";
                    text = "";
                    waiting = true;
                    showBall("file");
                    toast(ok ? "收到 " + inName + "，已存到 下载/共享夹" : "收到 " + inName);
                });
            });
            node.start();
            discovery = Discovery.get(this);
            discovery.setNodePort(node.port);
            discovery.start();
        } catch (Exception e) { Log.d("GXJ", "node init err " + e); }
    }

    /** 万一小条/球被误关或被系统清掉，自动补回来 */
    private void startWatchdog() {
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!alive) return;
                if (sp.getBoolean("ball_always", true) && !tabShown && !shown) showIdleBall();
                ui.postDelayed(this, 20000);
            }
        }, 20000);
    }

    /** 轮询兜底：长连接被系统掐掉时，也能在 10 秒内拿到新内容 */
    private void startPoll() {
        Thread t = new Thread(() -> {
            while (alive) {
                HttpURLConnection c = null;
                try {
                    String base = baseUrl();
                    String token = Uri.parse(sp.getString("web_url", "")).getQueryParameter("t");
                    if (!base.isEmpty() && token != null) {
                        c = (HttpURLConnection) new URL(base + "/api/state?t="
                                + URLEncoder.encode(token, "UTF-8")).openConnection();
                        c.setConnectTimeout(6000);
                        c.setReadTimeout(6000);
                        if (c.getResponseCode() == 200) {
                            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                            StringBuilder sb = new StringBuilder();
                            String line;
                            while ((line = r.readLine()) != null) sb.append(line);
                            r.close();
                            handleState(sb.toString());
                        }
                    }
                } catch (Exception ignored) {
                } finally {
                    if (c != null) c.disconnect();
                }
                try { Thread.sleep(10000); } catch (InterruptedException e) { break; }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    private void handleState(String json) {
        try {
            JSONObject o = new JSONObject(json);
            JSONArray texts = o.optJSONArray("texts");
            JSONArray files = o.optJSONArray("files");

            long textM = 0;
            String textName = "";
            String textBody = "";
            if (texts != null && texts.length() > 0) {
                JSONObject t = texts.getJSONObject(0);
                textM = t.optLong("mtime");
                textName = t.optString("name");
                textBody = t.optString("text");
            }

            String filePath = "";
            String fileName = "";
            if (files != null && files.length() > 0) {
                JSONObject f = files.getJSONObject(0);
                filePath = f.optString("path");
                fileName = f.optString("name");
            }

            long seenText = sp.getLong("seen_text", 0);
            String seenFile = sp.getString("seen_file", "");
            long fresh = System.currentTimeMillis() - 40 * 60 * 1000L; // 40 分钟内的才算新

            String newKind = null;
            String newName = "";
            String newText = "";
            String newPath = "";

            if (textM > seenText) {
                sp.edit().putLong("seen_text", textM).apply();
                if (textM >= fresh) {
                    newKind = "text";
                    newName = textName;
                    newText = textBody;
                }
            }
            if (newKind == null && !filePath.isEmpty() && !filePath.equals(seenFile)) {
                sp.edit().putString("seen_file", filePath).apply();
                if (!filePath.isEmpty()) {
                    newKind = "file";
                    newName = fileName.isEmpty() ? filePath : fileName;
                    newPath = filePath;
                }
            }
            if (newKind == null) return;

            // 自己刚发出去的文件，不要又被自己的球弹一次
            if ("file".equals(newKind)) {
                long at = sp.getLong("sent_at", 0);
                String names = sp.getString("sent_names", "");
                if (System.currentTimeMillis() - at < 40000 && !names.isEmpty()) {
                    for (String n : names.split("\\|")) {
                        if (!n.isEmpty() && newName.startsWith(n)) return;
                    }
                }
            }

            final String k = newKind;
            final String n = newName;
            final String t = newText;
            final String p = newPath;
            ui.post(() -> {
                kind = k;
                name = n;
                text = t;
                path = p;
                showBall(k);
            });
        } catch (Exception e) {
            Log.d("GXJ", "state parse err " + e);
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            if (intent.getBooleanExtra("show_idle", false)) ui.post(this::showIdleBall);
            if (intent.getBooleanExtra("hide_idle", false)) ui.post(this::hideBall);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        alive = false;
        cancelRetract();
        hideTab();
        try { if (node != null) node.stop(); } catch (Exception ignored) {}
        try { if (discovery != null) discovery.stop(); } catch (Exception ignored) {}
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
        cancelAutoHide();
        if (sseThread != null) sseThread.interrupt();
        if (shown && root != null) {
            try { wm.removeView(root); } catch (Exception ignored) {}
        }
        super.onDestroy();
    }
}
