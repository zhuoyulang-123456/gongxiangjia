package com.gongxiangjia.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.UUID;

/** 节点用的少量持久化配置 */
public class Prefs {
    public static SharedPreferences sp(Context c) { return c.getSharedPreferences("gxj", Context.MODE_PRIVATE); }

    public static String deviceId(Context c) {
        String id = sp(c).getString("device_id", "");
        if (id.isEmpty()) {
            id = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
            sp(c).edit().putString("device_id", id).apply();
        }
        return id;
    }

    public static String token(Context c) {
        String t = sp(c).getString("node_token", "");
        if (t.isEmpty()) {
            t = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
            sp(c).edit().putString("node_token", t).apply();
        }
        return t;
    }

    public static String name(Context c) {
        String n = sp(c).getString("device_name", "");
        if (n.isEmpty()) n = Build.MANUFACTURER + " " + Build.MODEL;
        return n;
    }
}
