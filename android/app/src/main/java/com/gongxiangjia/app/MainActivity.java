package com.gongxiangjia.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import android.media.MediaScannerConnection;

public class MainActivity extends Activity {

    private static final String PREFS = "gxj";
    private static final String KEY_URL = "web_url";
    private static final int REQ_FILE = 1001;
    private static final int REQ_PICK_SEND = 1003;

    private WebView web;
    private EditText urlInput;
    private TextView errorText;
    private Button goButton;
    private FrameLayout root;
    private SharedPreferences sp;

    private ValueCallback<Uri[]> filePathCallback;

    // ---------------- 生命周期 ----------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.d("GXJ", "onCreate start");
        sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        publishShareTarget();
        applyBarColors();
        setContentView(buildUi());

        Intent it = getIntent();
        String shortcut = it != null ? it.getStringExtra("gxj_action") : null;
        String incoming = it != null ? it.getStringExtra("url") : null;
        String saved = !TextUtils.isEmpty(incoming) ? incoming : sp.getString(KEY_URL, "");

        if (!TextUtils.isEmpty(saved)) {
            if (!TextUtils.isEmpty(incoming)) sp.edit().putString(KEY_URL, incoming).apply();
            load(saved);
            maybeStartBall();
            handleShareIntent(it);
        } else {
            showConnect(shareHint(it));
        }
        if (!TextUtils.isEmpty(shortcut)) runShortcut(shortcut);
    }

    /** 桌面长按图标的快捷方式 */
    private void runShortcut(String what) {
        if (!TextUtils.isEmpty(baseUrl()) && !TextUtils.isEmpty(token())) {
            if ("send-file".equals(what)) { pickFilesToSend(); return; }
            if ("send-photo".equals(what)) { pickPhotosToSend(); return; }
            if ("send-peer".equals(what)) { pickPeerThenFile(); return; }
            if ("send-clip".equals(what)) {
                // Android 10+ 需要窗口拿到焦点才能读剪贴板，所以等一下再读
                new android.os.Handler(getMainLooper()).postDelayed(() -> {
                    String t = readClipboard();
                    if (TextUtils.isEmpty(t)) { toast("剪贴板里没有文字"); return; }
                    final String body = t;
                    new Thread(() -> toast(postText(baseUrl(), token(), body) ? "已发送到电脑" : "发送失败")).start();
                }, 450);
                return;
            }
        }
        toast("先连接电脑");
        showConnect(null);
    }

    private Discovery.Peer pendingPeer;

    /** 先选设备，再选文件，直接发过去 */
    private void pickPeerThenFile() {
        java.util.List<Discovery.Peer> ps = Discovery.peers();
        if (ps.isEmpty()) {
            toast("附近没发现其他设备，确认都在同一个 WiFi 下");
            return;
        }
        String[] names = new String[ps.size()];
        for (int i = 0; i < ps.size(); i++) {
            Discovery.Peer p = ps.get(i);
            names[i] = "手机".equals(p.kind) || "phone".equals(p.kind) ? "📱 " + p.name : "💻 " + p.name;
        }
        new android.app.AlertDialog.Builder(this)
                .setTitle("发送到哪台设备")
                .setItems(names, (d, which) -> {
                    pendingPeer = ps.get(which);
                    pickFilesToSend();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private boolean uploadToPeer(Uri uri) {
        HttpURLConnection conn = null;
        Discovery.Peer p = pendingPeer;
        if (p == null) return false;
        try {
            String name = displayName(uri);
            String target = "http://" + p.host + ":" + p.port + "/api/upload?name="
                    + URLEncoder.encode(name, "UTF-8") + "&t=" + URLEncoder.encode(p.token, "UTF-8");
            conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(120000);
            conn.setRequestProperty("Content-Type", "application/octet-stream");
            InputStream in = openStream(uri);
            if (in == null) return false;
            OutputStream out = conn.getOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
            out.close();
            in.close();
            return conn.getResponseCode() == 200;
        } catch (Exception e) {
            Log.d("GXJ", "peer upload err " + e);
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 选照片/截图直接发到电脑（用系统照片选择器，不需要相册权限） */
    private void pickPhotosToSend() {
        try {
            Intent i;
            if (Build.VERSION.SDK_INT >= 33) {
                i = new Intent(MediaStore.ACTION_PICK_IMAGES);
                i.setType("image/*");
                i.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 20);
            } else {
                i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("image/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(i, REQ_PICK_SEND);
        } catch (Exception e) {
            pickFilesToSend();
        }
    }

    /** 选文件直接发到电脑（不走分享面板） */
    private void pickFilesToSend() {
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(i, REQ_PICK_SEND);
        } catch (Exception e) {
            toast("打不开文件选择器");
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Log.d("GXJ", "onNewIntent action=" + (intent == null ? "null" : intent.getAction()));
        String shortcut = intent.getStringExtra("gxj_action");
        String incoming = intent.getStringExtra("url");
        if (!TextUtils.isEmpty(incoming)) {
            sp.edit().putString(KEY_URL, incoming).apply();
            load(incoming);
        } else if (!TextUtils.isEmpty(sp.getString(KEY_URL, ""))) {
            load(sp.getString(KEY_URL, ""));
            handleShareIntent(intent);
        } else {
            showConnect(shareHint(intent));
        }
        if (!TextUtils.isEmpty(shortcut)) runShortcut(shortcut);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyBarColors();
    }

    /** 状态栏 / 导航栏跟随浅色深色 */
    private void applyBarColors() {
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        int bg = Color.parseColor(dark ? "#0B1220" : "#F5F7FB");
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        w.setStatusBarColor(bg);
        w.setNavigationBarColor(bg);
        int flags = w.getDecorView().getSystemUiVisibility();
        if (Build.VERSION.SDK_INT >= 23) {
            flags = dark ? (flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR)
                    : (flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
        if (Build.VERSION.SDK_INT >= 26) {
            flags = dark ? (flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR)
                    : (flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
        w.getDecorView().setSystemUiVisibility(flags);
    }

    /** 注册「直接分享」目标：分享面板顶部会直接出现共享夹 */
    private void publishShareTarget() {
        if (Build.VERSION.SDK_INT < 29) return;
        try {
            ShortcutManager sm = (ShortcutManager) getSystemService(SHORTCUT_SERVICE);
            if (sm == null) return;
            Intent target = new Intent(this, MainActivity.class);
            target.setAction(Intent.ACTION_SEND);
            target.setType("text/plain");
            ShortcutInfo info = new ShortcutInfo.Builder(this, "gxj-share")
                    .setShortLabel("共享夹")
                    .setLongLabel("发送到共享夹")
                    .setIcon(Icon.createWithResource(this, R.mipmap.ic_launcher))
                    .setIntent(target)
                    .setCategories(Collections.singleton("com.gongxiangjia.app.SHARE"))
                    .setLongLived(true)
                    .build();
            sm.setDynamicShortcuts(Collections.singletonList(info));
        } catch (Exception ignored) {}
    }

    // ---------------- 界面 ----------------

    private View buildUi() {
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        int bgColor = Color.parseColor(dark ? "#0B1220" : "#F5F7FB");

        root = new FrameLayout(this);
        root.setBackgroundColor(bgColor);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.setBackgroundColor(bgColor);
        web.addJavascriptInterface(new Bridge(), "GXJ");
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showConnect("连不上电脑。确认电脑开着共享夹、和手机在同一个网络。");
                }
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showConnect("连不上电脑。确认电脑开着共享夹、和手机在同一个网络。");
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }
        });

        // 自己下载再写进「下载/共享夹」：国产 ROM 的 DownloadManager 经常被拦
        web.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            String p = Uri.parse(url).getQueryParameter("p");
            String name = (p != null && !p.isEmpty())
                    ? p.substring(p.lastIndexOf('/') + 1)
                    : URLUtil.guessFileName(url, contentDisposition, mimetype);
            startDownload(url, name);
        });

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout panel = buildConnectPanel(dark);
        root.addView(panel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        return root;
    }

    private LinearLayout buildConnectPanel(boolean dark) {
        String textColor = dark ? "#E8EEF9" : "#0F172A";
        String mutedColor = dark ? "#8C9CB5" : "#64748B";
        String fieldBg = dark ? "#131C2E" : "#FFFFFF";
        String panelBg = dark ? "#0B1220" : "#F5F7FB";

        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.setBackgroundColor(Color.parseColor(panelBg));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(dp(26), dp(48), dp(26), dp(32));

        TextView logo = new TextView(this);
        logo.setText("共享夹");
        logo.setTextSize(30);
        logo.setTextColor(Color.parseColor(textColor));
        logo.setTypeface(logo.getTypeface(), android.graphics.Typeface.BOLD);
        logo.setGravity(Gravity.CENTER);
        panel.addView(logo, lp(-2, -2, 0, 0, 0, 0));

        TextView sub = new TextView(this);
        sub.setText("把电脑上的共享夹，装进手机");
        sub.setTextSize(14);
        sub.setTextColor(Color.parseColor(mutedColor));
        sub.setGravity(Gravity.CENTER);
        panel.addView(sub, lp(-2, -2, 0, dp(8), 0, dp(30)));

        urlInput = new EditText(this);
        urlInput.setHint("粘贴电脑上显示的地址");
        urlInput.setTextSize(13);
        urlInput.setSingleLine(false);
        urlInput.setMinLines(2);
        urlInput.setBackgroundResource(dark ? R.drawable.field_bg_dark : R.drawable.field_bg);
        urlInput.setPadding(dp(14), dp(12), dp(14), dp(12));
        urlInput.setTextColor(Color.parseColor(textColor));
        urlInput.setHintTextColor(Color.parseColor(mutedColor));
        panel.addView(urlInput, lp(-1, -2, 0, 0, 0, 0));

        errorText = new TextView(this);
        errorText.setTextSize(13);
        errorText.setTextColor(Color.parseColor("#DC2626"));
        errorText.setVisibility(View.GONE);
        panel.addView(errorText, lp(-2, -2, 0, dp(8), 0, 0));

        goButton = new Button(this);
        goButton.setText("连接电脑");
        goButton.setTextSize(16);
        goButton.setTextColor(Color.WHITE);
        goButton.setAllCaps(false);
        goButton.setBackgroundResource(R.drawable.btn_primary);
        goButton.setOnClickListener(v -> {
            String u = normalize(urlInput.getText().toString().trim());
            if (TextUtils.isEmpty(u)) {
                showError("先粘贴电脑上显示的那串地址");
                return;
            }
            sp.edit().putString(KEY_URL, u).apply();
            hideKeyboard();
            load(u);
        });
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(50));
        bp.topMargin = dp(20);
        panel.addView(goButton, bp);

        Button paste = new Button(this);
        paste.setText("从剪贴板粘贴");
        paste.setTextSize(14);
        paste.setTextColor(Color.parseColor("#2563EB"));
        paste.setAllCaps(false);
        paste.setBackgroundResource(R.drawable.btn_ghost);
        paste.setOnClickListener(v -> {
            String t = readClipboard();
            if (TextUtils.isEmpty(t)) { toast("剪贴板是空的"); return; }
            urlInput.setText(t.trim());
            errorText.setVisibility(View.GONE);
        });
        panel.addView(paste, lp(-2, -2, 0, dp(6), 0, 0));

        ballRow = new TextView(this);
        ballRow.setTextSize(13);
        ballRow.setGravity(Gravity.CENTER);
        ballRow.setPadding(dp(12), dp(14), dp(12), dp(14));
        ballRow.setOnClickListener(v -> toggleBall());
        LinearLayout.LayoutParams brp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        brp.topMargin = dp(10);
        panel.addView(ballRow, brp);
        refreshBallRow();

        alwaysRow = new TextView(this);
        alwaysRow.setTextSize(13);
        alwaysRow.setGravity(Gravity.CENTER);
        alwaysRow.setPadding(dp(12), dp(8), dp(12), dp(14));
        alwaysRow.setOnClickListener(v -> toggleAlways());
        LinearLayout.LayoutParams arp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        arp.topMargin = dp(2);
        panel.addView(alwaysRow, arp);
        refreshAlwaysRow();

        TextView hint = new TextView(this);
        hint.setText("电脑上点右上角「手机访问」，复制那串地址粘贴到这里。\n手机和电脑要在同一个 WiFi 下。\n\n连上以后，按返回键可以随时回到这里换地址。\n\n悬浮球收不到推送？点下面一行去系统设置里允许后台运行。");
        hint.setTextSize(12);
        hint.setTextColor(Color.parseColor(mutedColor));
        hint.setLineSpacing(dp(3), 1f);
        panel.addView(hint, lp(-2, -2, 0, dp(14), 0, dp(6)));

        TextView allowRow = new TextView(this);
        allowRow.setText("点这里：允许共享夹后台运行（锁屏也能收到）");
        allowRow.setTextSize(12.5f);
        allowRow.setTextColor(Color.parseColor("#2563EB"));
        allowRow.setGravity(Gravity.CENTER);
        allowRow.setPadding(0, dp(6), 0, dp(10));
        allowRow.setOnClickListener(v -> {
            try {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getPackageName())));
            } catch (Exception ignored) {}
            toast("在「电池 / 耗电管理」里选「允许后台高耗电」");
        });
        panel.addView(allowRow, lp(-2, -2, 0, 0, 0, dp(8)));

        scroll.addView(panel, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        wrap.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        connectPanelHolder = wrap;
        return wrap;
    }

    private LinearLayout connectPanelHolder;
    private TextView ballRow;
    private TextView alwaysRow;

    private void refreshAlwaysRow() {
        if (alwaysRow == null) return;
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        if (sp.getBoolean("ball_always", true)) {
            alwaysRow.setText("小球常驻：已开启 · 平时就在，点它就能发送");
            alwaysRow.setTextColor(Color.parseColor("#2563EB"));
        } else {
            alwaysRow.setText("小球常驻：已关闭 · 点此让小球一直显示");
            alwaysRow.setTextColor(Color.parseColor(dark ? "#8C9CB5" : "#64748B"));
        }
    }

    private void toggleAlways() {
        boolean on = sp.getBoolean("ball_always", true);
        sp.edit().putBoolean("ball_always", !on).apply();
        if (!Settings.canDrawOverlays(this)) {
            toast("先在上一行允许「显示在其他应用上层」");
            return;
        }
        if (!sp.getBoolean("ball_on", false)) {
            ballPref(true);
            startBallService();
        }
        try {
            Intent i = new Intent(this, BallService.class);
            i.putExtra(on ? "hide_idle" : "show_idle", true);
            startService(i);
        } catch (Exception ignored) {}
        refreshAlwaysRow();
        toast(on ? "小球已收起" : "小球常驻已开启");
    }

    // ---------------- 悬浮球 ----------------

    private void ballPref(boolean on) {
        sp.edit().putBoolean("ball_on", on).apply();
    }

    private void maybeStartBall() {
        if (!sp.getBoolean("ball_on", false)) return;
        if (!Settings.canDrawOverlays(this)) return;
        startBallService();
    }

    private void startBallService() {
        try {
            Intent i = new Intent(this, BallService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (Exception e) {
            toast("悬浮球启动失败：" + e.getMessage());
        }
    }

    private void toggleBall() {
        if (!Settings.canDrawOverlays(this)) {
            toast("先允许「显示在其他应用上层」");
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName())));
            } catch (Exception ignored) {}
            return;
        }
        boolean on = sp.getBoolean("ball_on", false);
        ballPref(!on);
        if (!on) {
            startBallService();
            try {
                if (Build.VERSION.SDK_INT >= 33) {
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS",
                            "android.permission.READ_MEDIA_IMAGES"}, 1002);
                } else {
                    requestPermissions(new String[]{"android.permission.READ_EXTERNAL_STORAGE"}, 1002);
                }
            } catch (Exception ignored) {}
            toast("悬浮球已开启：收到文件/文字会弹出来");
            askIgnoreBattery();
        } else {
            stopService(new Intent(this, BallService.class));
            toast("悬浮球已关闭");
        }
        refreshBallRow();
    }

    /** 让系统别把后台连接掐掉，否则锁屏后收不到推送 */
    private void askIgnoreBattery() {
        if (Build.VERSION.SDK_INT < 23) return;
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null && pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception ignored) {}
    }

    private void refreshBallRow() {
        if (ballRow == null) return;
        boolean overlay = Settings.canDrawOverlays(this);
        boolean on = sp.getBoolean("ball_on", false);
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        if (!overlay) {
            ballRow.setText("悬浮球：未授权 · 点此允许「显示在其他应用上层」");
            ballRow.setTextColor(Color.parseColor("#D97706"));
        } else if (on) {
            ballRow.setText("悬浮球：已开启 · 平时隐藏，收到东西才弹出");
            ballRow.setTextColor(Color.parseColor("#2563EB"));
        } else {
            ballRow.setText("悬浮球：已关闭 · 点此开启");
            ballRow.setTextColor(Color.parseColor(dark ? "#8C9CB5" : "#64748B"));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshBallRow();
        refreshAlwaysRow();
        maybeStartBall();
    }

    private boolean isConnectShown() {
        return connectPanelHolder != null && connectPanelHolder.getVisibility() == View.VISIBLE;
    }

    private LinearLayout.LayoutParams lp(int w, int h, int l, int t, int r, int b) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                w == -1 ? ViewGroup.LayoutParams.MATCH_PARENT : (w == -2 ? ViewGroup.LayoutParams.WRAP_CONTENT : w),
                h == -1 ? ViewGroup.LayoutParams.MATCH_PARENT : (h == -2 ? ViewGroup.LayoutParams.WRAP_CONTENT : h));
        p.setMargins(l, t, r, b);
        return p;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ---------------- 连接 ----------------

    private String normalize(String s) {
        if (TextUtils.isEmpty(s)) return "";
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        return s;
    }

    private void load(String url) {
        connectPanelHolder.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(url);
    }

    private void showConnect(String message) {
        web.setVisibility(View.GONE);
        connectPanelHolder.setVisibility(View.VISIBLE);
        String saved = sp.getString(KEY_URL, "");
        if (!TextUtils.isEmpty(saved)) urlInput.setText(saved);
        if (!TextUtils.isEmpty(message)) showError(message);
        else errorText.setVisibility(View.GONE);
    }

    private void showError(String msg) {
        errorText.setText(msg);
        errorText.setVisibility(View.VISIBLE);
    }

    private void confirmQuit() {
        new android.app.AlertDialog.Builder(this)
                .setTitle("退出共享夹？")
                .setMessage("退出后不再接收文件，悬浮球也会消失。下次打开 App 即可恢复。")
                .setPositiveButton("退出", (d, w) -> {
                    try {
                        ballPref(false);
                        stopService(new Intent(this, BallService.class));
                    } catch (Exception ignored) {}
                    try {
                        if (web != null) { web.loadUrl("about:blank"); web.destroy(); }
                    } catch (Exception ignored) {}
                    finishAffinity();
                    System.exit(0);
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void hideKeyboard() {
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(urlInput.getWindowToken(), 0);
        } catch (Exception ignored) {}
    }

    private void toast(final String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }

    private String readClipboard() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm == null || cm.getPrimaryClip() == null || cm.getPrimaryClip().getItemCount() == 0) return "";
            CharSequence t = cm.getPrimaryClip().getItemAt(0).coerceToText(this);
            return t == null ? "" : t.toString();
        } catch (Exception e) { return ""; }
    }

    // ---------------- 网页桥 ----------------

    public class Bridge {
        @JavascriptInterface
        public boolean copy(final String text) {
            runOnUiThread(() -> {
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("共享夹", text == null ? "" : text));
                } catch (Exception ignored) {}
            });
            return true;
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    msg == null ? "" : msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public boolean ballOn() {
            return sp.getBoolean("ball_on", false);
        }

        @JavascriptInterface
        public boolean setBall(boolean on) {
            runOnUiThread(() -> {
                boolean cur = sp.getBoolean("ball_on", false);
                if (cur != on) toggleBall();
            });
            return true;
        }

        @JavascriptInterface
        public void settings() {
            runOnUiThread(() -> showConnect(null));
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public boolean isApp() {
            return true;
        }

        @JavascriptInterface
        public int statusBarHeight() {
            int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
            return id > 0 ? getResources().getDimensionPixelSize(id) : 0;
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(() -> web.reload());
        }
    }

    // ---------------- 下载 ----------------

    private void startDownload(final String url, final String name) {
        toast("开始下载 · " + name);
        new Thread(() -> {
            HttpURLConnection conn = null;
            File tmp = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(60000);
                conn.setInstanceFollowRedirects(true);
                int code = conn.getResponseCode();
                if (code != 200) { toast("下载失败：HTTP " + code); return; }
                String mime = conn.getContentType();
                tmp = new File(getCacheDir(), "dl-" + System.currentTimeMillis());
                InputStream in = conn.getInputStream();
                FileOutputStream out = new FileOutputStream(tmp);
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                out.flush();
                out.close();
                in.close();
                String saved = saveToDownloads(tmp, name, mime);
                if (saved != null) toast("已保存到 下载/共享夹 · " + name);
                else toast("保存失败，检查存储权限");
            } catch (Exception e) {
                toast("下载失败：" + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
                if (tmp != null) tmp.delete();
            }
        }).start();
    }

    private String saveToDownloads(File src, String name, String mime) {
        String safe = TextUtils.isEmpty(name) ? "共享夹文件" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
        String type = TextUtils.isEmpty(mime) ? "application/octet-stream" : mime;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                v.put(MediaStore.MediaColumns.MIME_TYPE, type);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/共享夹");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri item = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (item == null) return null;
                OutputStream os = getContentResolver().openOutputStream(item);
                InputStream is = new FileInputStream(src);
                byte[] b = new byte[64 * 1024];
                int n;
                while ((n = is.read(b)) > 0) os.write(b, 0, n);
                os.flush();
                os.close();
                is.close();
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(item, done, null, null);
                return item.toString();
            }
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "共享夹");
            if (!dir.exists() && !dir.mkdirs()) return null;
            File dest = new File(dir, safe);
            InputStream is = new FileInputStream(src);
            OutputStream os = new FileOutputStream(dest);
            byte[] b = new byte[64 * 1024];
            int n;
            while ((n = is.read(b)) > 0) os.write(b, 0, n);
            os.flush();
            os.close();
            is.close();
            MediaScannerConnection.scanFile(this, new String[]{dest.getAbsolutePath()}, null, null);
            return dest.getAbsolutePath();
        } catch (Exception e) {
            Log.d("GXJ", "save err=" + e);
            return null;
        }
    }

    // ---------------- 分享进来就上传 ----------------

    private String shareHint(Intent intent) {
        if (intent == null) return null;
        String a = intent.getAction();
        if (Intent.ACTION_SEND.equals(a) || Intent.ACTION_SEND_MULTIPLE.equals(a)
                || Intent.ACTION_VIEW.equals(a)) {
            return "先连上电脑，打开的文件就会自动放进去";
        }
        return null;
    }

    private String baseUrl() {
        try {
            Uri u = Uri.parse(sp.getString(KEY_URL, ""));
            if (u.getHost() == null) return "";
            int port = u.getPort();
            return u.getScheme() + "://" + u.getHost() + (port > 0 ? ":" + port : "");
        } catch (Exception e) { return ""; }
    }

    private String token() {
        try {
            Uri u = Uri.parse(sp.getString(KEY_URL, ""));
            String t = u.getQueryParameter("t");
            return t == null ? "" : t;
        } catch (Exception e) { return ""; }
    }

    private void handleShareIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Log.d("GXJ", "share action=" + action + " type=" + intent.getType() + " base=" + baseUrl() + " tokenLen=" + token().length());
        boolean isView = Intent.ACTION_VIEW.equals(action) && intent.getData() != null;
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action) && !isView) return;

        final String base = baseUrl();
        final String tk = token();
        if (TextUtils.isEmpty(base) || TextUtils.isEmpty(tk)) {
            toast("先连接电脑，分享的内容会自动放进去");
            return;
        }

        String type = intent.getType() == null ? "" : intent.getType();

        if (type.startsWith("text/")) {
            final String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (TextUtils.isEmpty(text)) return;
            new Thread(() -> {
                boolean ok = postText(base, tk, text);
                toast(ok ? "已把文字传到电脑" : "文字发送失败");
            }).start();
            return;
        }

        final List<Uri> uris = new ArrayList<>();
        if (isView) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        }
        if (uris.isEmpty()) return;

        toast("正在上传 " + uris.size() + " 个文件…");
        new Thread(() -> {
            int ok = 0;
            for (Uri u : uris) {
                if (uploadUri(base, tk, u)) ok++;
            }
            final int n = ok;
            final int total = uris.size();
            toast(n == total ? "已上传 " + n + " 个文件" : "上传了 " + n + "/" + total);
            runOnUiThread(() -> { if (web != null && web.getVisibility() == View.VISIBLE) web.reload(); });
        }).start();
    }

    /** content:// 走 ContentResolver；file:// 直接读（部分老应用这么分享） */
    private InputStream openStream(Uri uri) throws Exception {
        if ("file".equals(uri.getScheme())) {
            return new java.io.FileInputStream(new java.io.File(uri.getPath()));
        }
        return getContentResolver().openInputStream(uri);
    }

    private String displayName(Uri uri) {
        String name = null;
        try {
            ContentResolver cr = getContentResolver();
            Cursor c = cr.query(uri, null, null, null, null);
            if (c != null) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && c.moveToFirst()) name = c.getString(idx);
                c.close();
            }
        } catch (Exception ignored) {}
        if (TextUtils.isEmpty(name)) {
            name = uri.getLastPathSegment();
            if (name != null) name = name.substring(name.lastIndexOf('/') + 1);
        }
        if (TextUtils.isEmpty(name)) name = "分享文件";
        return name;
    }

    private boolean uploadUri(String base, String tk, Uri uri) {
        HttpURLConnection conn = null;
        try {
            String name = displayName(uri);
            String target = base + "/api/upload?name=" + URLEncoder.encode(name, "UTF-8")
                    + "&t=" + URLEncoder.encode(tk, "UTF-8");
            conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(60000);
            conn.setRequestProperty("Content-Type", "application/octet-stream");
            InputStream in = openStream(uri);
            if (in == null) return false;
            OutputStream out = conn.getOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
            out.close();
            in.close();
            int code = conn.getResponseCode();
            Log.d("GXJ", "text done code=" + code);
            return code == 200;
        } catch (Exception e) {
            Log.d("GXJ", "text post err=" + e);
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private boolean postText(String base, String tk, String text) {
        HttpURLConnection conn = null;
        try {
            String target = base + "/api/text?t=" + URLEncoder.encode(tk, "UTF-8");
            conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(20000);
            conn.setRequestProperty("Content-Type", "text/plain; charset=utf-8");
            OutputStream out = conn.getOutputStream();
            out.write(text.getBytes("UTF-8"));
            out.flush();
            out.close();
            Log.d("GXJ", "file done code=" + conn.getResponseCode());
            return conn.getResponseCode() == 200;
        } catch (Exception e) {
            Log.d("GXJ", "upload err=" + e);
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // ---------------- 返回键 ----------------

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_SEND) {
            final List<Uri> picked = new ArrayList<>();
            if (data != null) {
                if (data.getClipData() != null) {
                    ClipData cd = data.getClipData();
                    for (int i = 0; i < cd.getItemCount(); i++) picked.add(cd.getItemAt(i).getUri());
                } else if (data.getData() != null) {
                    picked.add(data.getData());
                }
            }
            if (!picked.isEmpty()) {
                toast("正在发送 " + picked.size() + " 个文件…");
                final String base = baseUrl();
                final String tk = token();
                final boolean toPeer = pendingPeer != null;
                final StringBuilder echoNames = new StringBuilder();
                for (Uri u : picked) {
                    String dn = displayName(u);
                    int dot = dn.lastIndexOf('.');
                    echoNames.append(dot > 0 ? dn.substring(0, dot) : dn).append('|');
                }
                new Thread(() -> {
                    int ok = 0;
                    for (Uri u : picked) {
                        if (toPeer ? uploadToPeer(u) : uploadUri(base, tk, u)) ok++;
                    }
                    if (ok > 0) sp.edit().putString("sent_names", echoNames.toString())
                            .putLong("sent_at", System.currentTimeMillis()).apply();
                    final int n = ok, total = picked.size();
                    toast(n == total ? "已发送 " + n + " 个文件" : "发送了 " + n + "/" + total);
                    pendingPeer = null;
                    runOnUiThread(() -> { if (web != null && web.getVisibility() == View.VISIBLE) web.reload(); });
                }).start();
            }
            return;
        }
        if (requestCode == REQ_FILE) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (!isConnectShown() && web.canGoBack()) {
            web.goBack();
        } else if (!isConnectShown()) {
            showConnect(null);
        } else {
            super.onBackPressed();
        }
    }
}
