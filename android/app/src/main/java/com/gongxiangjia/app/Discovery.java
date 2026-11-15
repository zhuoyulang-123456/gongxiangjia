package com.gongxiangjia.app;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** 局域网设备发现：所有设备（手机/平板/电脑）都往 8795 端口广播自己的地址 */
public class Discovery {

    public static final int PORT = 8795;

    public static class Peer {
        public String id, name, kind, host, token;
        public int port;
        public long seen;
        public String label() { return name + " · " + kind; }
    }

    private static final Map<String, Peer> PEERS = new ConcurrentHashMap<>();
    private static Discovery instance;

    private final Context ctx;
    private DatagramSocket sock;
    private volatile boolean running = false;
    private int nodePort = 0;
    private Thread loop;

    public static synchronized Discovery get(Context c) {
        if (instance == null) instance = new Discovery(c.getApplicationContext());
        return instance;
    }

    public static List<Peer> peers() {
        List<Peer> out = new ArrayList<>();
        long now = System.currentTimeMillis();
        for (Peer p : PEERS.values()) if (now - p.seen < 15000) out.add(p);
        out.sort((a, b) -> Long.compare(b.seen, a.seen));
        return out;
    }

    private Discovery(Context c) { this.ctx = c; }

    public void setNodePort(int p) { nodePort = p; }

    public synchronized void start() {
        if (running) return;
        try {
            sock = new DatagramSocket(PORT);
            sock.setBroadcast(true);
            sock.setSoTimeout(1000);
            running = true;
        } catch (Exception e) {
            Log.d("GXJ", "discovery start fail " + e);
            return;
        }
        loop = new Thread(() -> {
            long last = 0;
            byte[] buf = new byte[2048];
            while (running) {
                try {
                    long now = System.currentTimeMillis();
                    if (now - last > 3000) {
                        last = now;
                        announce();
                    }
                    DatagramPacket pkt = new DatagramPacket(buf, buf.length);
                    sock.receive(pkt);
                    String json = new String(pkt.getData(), 0, pkt.getLength(), "UTF-8");
                    JSONObject o = new JSONObject(json);
                    if (!"gxj".equals(o.optString("gxj"))) continue;
                    String id = o.optString("id");
                    if (id.isEmpty() || id.equals(Prefs.deviceId(ctx))) continue;
                    Peer p = new Peer();
                    p.id = id;
                    p.name = o.optString("name");
                    p.kind = o.optString("kind", "device");
                    p.port = o.optInt("port", 8790);
                    p.token = o.optString("token");
                    p.host = pkt.getAddress().getHostAddress();
                    p.seen = now;
                    PEERS.put(id, p);
                } catch (java.net.SocketTimeoutException ignore) {
                } catch (Exception e) {
                    if (!running) break;
                }
            }
        });
        loop.setDaemon(true);
        loop.start();
    }

    private void announce() {
        try {
            JSONObject o = new JSONObject();
            o.put("gxj", "1");
            o.put("id", Prefs.deviceId(ctx));
            o.put("name", Prefs.name(ctx));
            o.put("kind", "phone");
            o.put("port", nodePort);
            o.put("token", Prefs.token(ctx));
            byte[] data = o.toString().getBytes("UTF-8");

            List<java.net.InetAddress> targets = new ArrayList<>();
            targets.add(java.net.InetAddress.getByName("255.255.255.255"));
            for (java.net.NetworkInterface ni : java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (java.net.InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    java.net.InetAddress b = ia.getBroadcast();
                    if (b != null) targets.add(b);
                }
            }
            for (java.net.InetAddress t : targets) {
                try {
                    sock.send(new DatagramPacket(data, data.length, t, PORT));
                } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
    }

    public void stop() {
        running = false;
        try { if (sock != null) sock.close(); } catch (Exception ignored) {}
    }
}
