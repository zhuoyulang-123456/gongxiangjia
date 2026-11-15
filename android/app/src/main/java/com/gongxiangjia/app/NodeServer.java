package com.gongxiangjia.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 手机端轻量文件节点：让其他设备（手机/平板/电脑）能直接发文件给它。
 * 接口和电脑端保持一致：/api/state、/api/upload、/api/file。
 */
public class NodeServer {

    public static final int DEFAULT_PORT = 8790;

    private final Context ctx;
    private ServerSocket server;
    private volatile boolean running = false;
    public int port = 0;

    public interface OnFileIn {
        void onFileIn(String name, long size);
    }
    private OnFileIn listener;

    public NodeServer(Context ctx) { this.ctx = ctx.getApplicationContext(); }
    public void setOnFileIn(OnFileIn l) { this.listener = l; }

    public File root() {
        File dir = new File(ctx.getExternalFilesDir(null), "共享夹");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    public synchronized void start() {
        if (running) return;
        try {
            server = new ServerSocket(DEFAULT_PORT);
            port = DEFAULT_PORT;
        } catch (Exception e) {
            try {
                server = new ServerSocket(0);
                port = server.getLocalPort();
            } catch (Exception e2) {
                Log.d("GXJ", "node start fail " + e2);
                return;
            }
        }
        running = true;
        Thread t = new Thread(() -> {
            while (running) {
                try {
                    final Socket s = server.accept();
                    new Thread(() -> handle(s)).start();
                } catch (Exception e) {
                    if (!running) break;
                }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    public void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (Exception ignored) {}
    }

    public List<Map<String, Object>> listFiles() {
        List<Map<String, Object>> out = new ArrayList<>();
        File[] fs = root().listFiles();
        if (fs == null) return out;
        for (File f : fs) {
            if (!f.isFile() || f.getName().startsWith(".")) continue;
            Map<String, Object> m = new HashMap<>();
            m.put("path", f.getName());
            m.put("name", f.getName());
            m.put("size", f.length());
            m.put("mtime", f.lastModified());
            out.add(m);
        }
        Collections.sort(out, (a, b) -> Long.compare((long) b.get("mtime"), (long) a.get("mtime")));
        return out;
    }

    // ---------------- 请求处理 ----------------

    private void handle(Socket sock) {
        try {
            sock.setSoTimeout(30000);
            InputStream raw = sock.getInputStream();

            // 手工读头部，读完直接接原始流（上传时不能经过字符流）
            ByteArrayOutputStream headBuf = new ByteArrayOutputStream();
            int b, nl = 0;
            while ((b = raw.read()) != -1) {
                headBuf.write(b);
                if (b == '\n') {
                    nl++;
                    if (nl == 2) break;   // 空行 = 头结束
                } else if (b != '\r') {
                    nl = 0;
                }
            }
            String head = headBuf.toString("UTF-8");
            String[] lines = head.split("\r\n");
            if (lines.length == 0) { sock.close(); return; }
            String[] rl = lines[0].split(" ");
            String method = rl.length > 0 ? rl[0] : "GET";
            String target = rl.length > 1 ? rl[1] : "/";

            long contentLength = -1;
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c > 0 && lines[i].substring(0, c).trim().equalsIgnoreCase("content-length")) {
                    try { contentLength = Long.parseLong(lines[i].substring(c + 1).trim()); } catch (Exception ignored) {}
                }
            }

            String bare = target;
            Map<String, String> params = new HashMap<>();
            if (target.contains("?")) {
                bare = target.substring(0, target.indexOf('?'));
                for (String kv : target.substring(target.indexOf('?') + 1).split("&")) {
                    int i = kv.indexOf('=');
                    if (i > 0) params.put(kv.substring(0, i), URLDecoder.decode(kv.substring(i + 1), "UTF-8"));
                }
            }

            String token = params.containsKey("t") ? params.get("t") : "";
            if (!Prefs.token(ctx).equals(token)) {
                respond(sock, 401, "text/plain; charset=utf-8", "令牌无效".getBytes("UTF-8"));
                return;
            }

            if ("/api/state".equals(bare)) {
                JSONObject o = new JSONObject();
                o.put("name", Prefs.name(ctx));
                o.put("kind", "phone");
                JSONArray arr = new JSONArray();
                for (Map<String, Object> m : listFiles()) {
                    JSONObject f = new JSONObject();
                    f.put("path", m.get("path"));
                    f.put("name", m.get("name"));
                    f.put("size", m.get("size"));
                    f.put("mtime", m.get("mtime"));
                    arr.put(f);
                }
                o.put("files", arr);
                o.put("texts", new JSONArray());
                respond(sock, 200, "application/json; charset=utf-8", o.toString().getBytes("UTF-8"));
                return;
            }

            if ("/api/upload".equals(bare) && "POST".equals(method)) {
                String name = params.containsKey("name") ? params.get("name") : "收到的文件";
                name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
                if (name.trim().isEmpty()) name = "收到的文件";
                File dest = unique(name);
                FileOutputStream out = new FileOutputStream(dest);
                byte[] buf = new byte[64 * 1024];
                long left = contentLength;
                while (left != 0) {
                    int want = (left > 0) ? (int) Math.min(buf.length, left) : buf.length;
                    int r = raw.read(buf, 0, want);
                    if (r <= 0) break;
                    out.write(buf, 0, r);
                    if (left > 0) left -= r;
                    if (left == 0) break;
                }
                out.flush();
                out.close();
                respond(sock, 200, "application/json; charset=utf-8",
                        ("{\"ok\":true,\"name\":\"" + dest.getName() + "\"}").getBytes("UTF-8"));
                if (listener != null) listener.onFileIn(dest.getName(), dest.length());
                return;
            }

            if ("/api/file".equals(bare)) {
                String rel = params.containsKey("p") ? params.get("p") : "";
                rel = rel.replaceAll("[\\\\/]", "_");
                File f = new File(root(), rel);
                if (!f.exists() || !f.isFile()) { respond(sock, 404, "text/plain", "not found".getBytes("UTF-8")); return; }
                byte[] data = new byte[(int) f.length()];
                java.io.FileInputStream fin = new java.io.FileInputStream(f);
                int off = 0, n;
                while (off < data.length && (n = fin.read(data, off, data.length - off)) > 0) off += n;
                fin.close();
                respond(sock, 200, "application/octet-stream", data);
                return;
            }

            respond(sock, 404, "text/plain", "not found".getBytes("UTF-8"));
        } catch (Exception e) {
            Log.d("GXJ", "node handle err " + e);
            try { sock.close(); } catch (Exception ignored) {}
        }
    }

    private File unique(String name) {
        File dest = new File(root(), name);
        String stem = name, ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) { stem = name.substring(0, dot); ext = name.substring(dot); }
        int n = 1;
        while (dest.exists()) { dest = new File(root(), stem + " (" + n + ")" + ext); n++; }
        return dest;
    }

    private void respond(Socket s, int code, String type, byte[] body) throws Exception {
        OutputStream os = s.getOutputStream();
        String head = "HTTP/1.1 " + code + " OK\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n\r\n";
        os.write(head.getBytes("UTF-8"));
        os.write(body);
        os.flush();
        s.close();
    }
}
