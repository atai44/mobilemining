package io.github.atai44.mobilemining;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AnkiDroidPlugin.class);
        registerPlugin(LookupPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
