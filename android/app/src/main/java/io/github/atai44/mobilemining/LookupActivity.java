package io.github.atai44.mobilemining;

import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

/**
 * The dictionary as a panel over whatever app you are in: opened from the text-selection menu
 * ("MobileMining") or by sharing text. It covers the lower part of the screen; tapping outside
 * or pressing back returns to the app underneath.
 */
public class LookupActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AnkiDroidPlugin.class);
        registerPlugin(LookupPlugin.class);
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        int height = (int) (getResources().getDisplayMetrics().heightPixels * 0.62);
        w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, height);
        w.setGravity(Gravity.BOTTOM);
        w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        w.setDimAmount(0.25f);
        setFinishOnTouchOutside(true);
    }

    /** Another selection while the panel is open: show that one. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (bridge != null) bridge.triggerWindowJSEvent("mobileminingLookup");
    }
}
