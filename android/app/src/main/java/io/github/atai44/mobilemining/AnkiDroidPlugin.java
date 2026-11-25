package io.github.atai44.mobilemining;

import android.content.Intent;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.ichi2.anki.api.AddContentApi;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;

/**
 * JavaScript access to AnkiDroid (see AnkiDroidBridge): decks, note types, notes, duplicates
 * and media. Plugin methods run on Capacitor's plugin thread, never on the UI thread.
 */
@CapacitorPlugin(
    name = "AnkiDroid",
    permissions = { @Permission(alias = "anki", strings = { AddContentApi.READ_WRITE_PERMISSION }) }
)
public class AnkiDroidPlugin extends Plugin {

    private interface Action {
        void run(AnkiDroidBridge anki) throws Exception;
    }

    private boolean installed() {
        return AnkiDroidBridge.ankiPackage(getContext()) != null;
    }

    private boolean granted() {
        return getPermissionState("anki") == PermissionState.GRANTED;
    }

    /** Runs an action against AnkiDroid, rejecting the call when it is unavailable or fails. */
    private void with(PluginCall call, Action action) {
        if (!installed()) {
            call.reject("AnkiDroid is not installed", "NOT_INSTALLED");
            return;
        }
        if (!granted()) {
            call.reject("No access to AnkiDroid yet: press Connect", "NO_PERMISSION");
            return;
        }
        try {
            action.run(new AnkiDroidBridge(getContext()));
        } catch (AnkiDroidBridge.AnkiException e) {
            call.reject(e.getMessage(), e);
        } catch (Exception e) {
            String m = e.getMessage();
            call.reject(e.getClass().getSimpleName() + (m == null ? "" : ": " + m), e);
        }
    }

    private JSObject statusObject() {
        boolean installed = installed();
        return new JSObject().put("installed", installed).put("granted", installed && granted());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusObject());
    }

    /** Asks for access to AnkiDroid's database (Android shows AnkiDroid's own permission prompt). */
    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (!installed()) call.reject("AnkiDroid is not installed", "NOT_INSTALLED");
        else if (granted()) call.resolve(statusObject());
        else requestPermissionForAlias("anki", call, "accessCallback");
    }

    @PermissionCallback
    private void accessCallback(PluginCall call) {
        call.resolve(statusObject());
    }

    @PluginMethod
    public void decks(PluginCall call) {
        with(call, (anki) -> call.resolve(new JSObject().put("names", new JSArray(anki.decks()))));
    }

    @PluginMethod
    public void models(PluginCall call) {
        with(call, (anki) -> call.resolve(new JSObject().put("names", new JSArray(anki.models()))));
    }

    @PluginMethod
    public void fields(PluginCall call) {
        with(call, (anki) -> {
            JSArray names = new JSArray();
            for (String n : anki.fields(call.getString("model"))) names.put(n);
            call.resolve(new JSObject().put("names", names));
        });
    }

    @PluginMethod
    public void addDeck(PluginCall call) {
        with(call, (anki) -> call.resolve(new JSObject().put("id", String.valueOf(anki.deck(call.getString("name"))))));
    }

    @PluginMethod
    public void addModel(PluginCall call) {
        with(call, (anki) -> {
            long id = anki.addModel(call.getString("name"), strings(call.getArray("fields")), strings(call.getArray("cards")),
                strings(call.getArray("qfmt")), strings(call.getArray("afmt")), call.getString("css", ""));
            call.resolve(new JSObject().put("id", String.valueOf(id)));
        });
    }

    @PluginMethod
    public void findDuplicates(PluginCall call) {
        with(call, (anki) -> {
            JSArray ids = new JSArray();
            for (Long id : anki.findDuplicates(call.getString("model"), call.getString("key", ""))) ids.put(String.valueOf(id));
            call.resolve(new JSObject().put("ids", ids));
        });
    }

    /** Which of these note ids still exist (to notice cards deleted in AnkiDroid). */
    @PluginMethod
    public void existing(PluginCall call) {
        with(call, (anki) -> {
            java.util.List<Long> ids = new java.util.ArrayList<>();
            for (String s : strings(call.getArray("ids"))) ids.add(Long.parseLong(s));
            JSArray out = new JSArray();
            for (Long id : anki.existing(ids)) out.put(String.valueOf(id));
            call.resolve(new JSObject().put("ids", out));
        });
    }

    @PluginMethod
    public void addNote(PluginCall call) {
        with(call, (anki) -> {
            long id = anki.addNote(call.getString("model"), call.getString("deck", "Default"), map(call.getObject("fields")), tags(call.getArray("tags")));
            call.resolve(new JSObject().put("id", String.valueOf(id)));
        });
    }

    @PluginMethod
    public void updateNote(PluginCall call) {
        with(call, (anki) -> {
            anki.updateNote(Long.parseLong(call.getString("id", "0")), call.getString("model"), map(call.getObject("fields")));
            call.resolve();
        });
    }

    /** Stores a file (base64) in AnkiDroid's media folder; returns its field text and file name. */
    @PluginMethod
    public void addMedia(PluginCall call) {
        with(call, (anki) -> {
            byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            String tag = anki.addMedia(call.getString("name", "file"), call.getString("ext", "jpg"), call.getString("kind", "image"), data);
            call.resolve(new JSObject().put("tag", tag).put("name", AnkiDroidBridge.mediaName(tag)));
        });
    }

    /** Brings AnkiDroid to the front. */
    @PluginMethod
    public void open(PluginCall call) {
        String pkg = AnkiDroidBridge.ankiPackage(getContext());
        Intent intent = pkg == null ? null : getContext().getPackageManager().getLaunchIntentForPackage(pkg);
        if (intent == null) {
            call.reject("AnkiDroid is not installed", "NOT_INSTALLED");
            return;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    private static String[] strings(JSArray a) throws Exception {
        if (a == null) return new String[0];
        String[] out = new String[a.length()];
        for (int i = 0; i < out.length; i++) out[i] = a.getString(i);
        return out;
    }

    private static Set<String> tags(JSArray a) throws Exception {
        Set<String> out = new HashSet<>();
        if (a != null) for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        return out;
    }

    private static Map<String, String> map(JSObject o) {
        Map<String, String> out = new HashMap<>();
        if (o == null) return out;
        for (Iterator<String> it = o.keys(); it.hasNext(); ) {
            String k = it.next();
            out.put(k, o.optString(k, ""));
        }
        return out;
    }
}
