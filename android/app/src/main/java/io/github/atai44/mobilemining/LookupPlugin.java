package io.github.atai44.mobilemining;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Text handed to the app from elsewhere: the "MobileMining" entry in Android's text-selection
 * menu (ACTION_PROCESS_TEXT) or shared text (ACTION_SEND).
 */
@CapacitorPlugin(name = "Lookup")
public class LookupPlugin extends Plugin {

    /** The text this window was opened for ('' in the normal app window). */
    static String textOf(Intent intent) {
        if (intent == null) return "";
        CharSequence text = null;
        if (Intent.ACTION_PROCESS_TEXT.equals(intent.getAction())) text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
        else if (Intent.ACTION_SEND.equals(intent.getAction())) text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        return text == null ? "" : text.toString();
    }

    @PluginMethod
    public void pending(PluginCall call) {
        boolean popup = getActivity() instanceof LookupActivity;
        call.resolve(new JSObject().put("text", popup ? textOf(getActivity().getIntent()) : "").put("popup", popup));
    }

    /** Closes the lookup window (back to the app the text came from). */
    @PluginMethod
    public void close(PluginCall call) {
        call.resolve();
        if (getActivity() instanceof LookupActivity) getActivity().finish();
    }
}
