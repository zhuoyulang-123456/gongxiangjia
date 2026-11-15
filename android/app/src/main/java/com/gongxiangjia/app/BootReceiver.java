package com.gongxiangjia.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;

/** 开机 / 应用更新后自动把悬浮球服务拉起来 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences("gxj", Context.MODE_PRIVATE);
            if (!sp.getBoolean("ball_on", false)) return;
            if (!Settings.canDrawOverlays(ctx)) return;
            Intent i = new Intent(ctx, BallService.class);
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception ignored) {}
    }
}
