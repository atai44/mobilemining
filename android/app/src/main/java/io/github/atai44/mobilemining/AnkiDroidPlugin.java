package io.github.atai44.mobilemining;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.core.content.FileProvider;

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
import com.ichi2.anki.api.NoteInfo;

import java.io.File;
import java.io.FileOutputStream;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Adds notes straight into AnkiDroid through its official API (the ContentProvider behind
 * com.ichi2.anki.api.AddContentApi): decks, note types, notes, duplicates and media.
 * Plugin methods run on Capacitor's plugin thread, never on the UI thread.
 */
@CapacitorPlugin(
    name = "AnkiDroid",
    permissions = { @Permission(alias = "anki", strings = { AddContentApi.READ_WRITE_PERMISSION }) }
)
public class AnkiDroidPlugin extends Plugin {

    private AddContentApi api() {
        return new AddContentApi(getContext());
    }

    private String ankiPackage() {
        return AddContentApi.getAnkiDroidPackageName(getContext());
    }

    private boolean granted() {
        return getPermissionState("anki") == PermissionState.GRANTED;
    }

    /** Rejects the call (and returns false) unless AnkiDroid is installed and access was granted. */
    private boolean ready(PluginCall call) {
        if (ankiPackage() == null) {
            call.reject("AnkiDroid is not installed", "NOT_INSTALLED");
            return false;
        }
        if (!granted()) {
            call.reject("No access to AnkiDroid yet: press Connect", "NO_PERMISSION");
            return false;
        }
        return true;
    }

    private Long idByName(Map<Long, String> map, String name) {
        if (map == null || name == null) return null;
        for (Map.Entry<Long, String> e : map.entrySet()) if (name.equals(e.getValue())) return e.getKey();
        return null;
    }

    private Long modelId(String name) {
        return idByName(api().getModelList(0), name);
    }

    private JSObject statusObject() {
        JSObject r = new JSObject();
        boolean installed = ankiPackage() != null;
        r.put("installed", installed);
        r.put("granted", installed && granted());
        return r;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusObject());
    }

    /** Asks for access to AnkiDroid's database (Android shows AnkiDroid's own permission prompt). */
    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (ankiPackage() == null) {
            call.reject("AnkiDroid is not installed", "NOT_INSTALLED");
            return;
        }
        if (granted()) call.resolve(statusObject());
        else requestPermissionForAlias("anki", call, "accessCallback");
    }

    @PermissionCallback
    private void accessCallback(PluginCall call) {
        call.resolve(statusObject());
    }

    @PluginMethod
    public void decks(PluginCall call) {
        if (!ready(call)) return;
        try {
            JSArray out = new JSArray();
            Map<Long, String> decks = api().getDeckList();
            if (decks != null) for (String name : decks.values()) out.put(name);
            call.resolve(new JSObject().put("names", out));
        } catch (Exception e) {
            call.reject(message(e), e);
        }
    }

    @PluginMethod
    public void models(PluginCall call) {
        if (!ready(call)) return;
        try {
            JSArray out = new JSArray();
            Map<Long, String> models = api().getModelList(0);
            if (models != null) for (String name : models.values()) out.put(name);
            call.resolve(new JSObject().put("names", out));
        } catch (Exception e) {
            call.reject(message(e), e);
        }
    }

    @PluginMethod
    public void fields(PluginCall call) {
        if (!ready(call)) return;
        try {
            Long mid = modelId(call.getString("model"));
            if (mid == null) {
                call.reject("Note type not found: " + call.getString("model"));
                return;
            }
            JSArray out = new JSArray();
            String[] names = api().getFieldList(mid);
            if (names != null) for (String n : names) out.put(n);
            call.resolve(new JSObject().put("names", out));
        } catch (Exception e) {
            call.reject(message(e), e);
        }
    }

    @PluginMethod
    public void addDeck(PluginCall call) {
        if (!ready(call)) return;
        try {
            String name = call.getString("name");
            Long id = idByName(api().getDeckList(), name);
            if (id == null) id = api().addNewDeck(name);
            if (id == null) call.reject("Could not create the deck");
            else call.resolve(new JSObject().put("id", String.valueOf(id)));
        } catch (Exception e) {
            call.reject(message(e), e);
        }
    }

    /** Creates a note type: fields, card names and their front/back templates, CSS. */
    @PluginMethod
    public void addModel(PluginCall call) {
        if (!ready(call)) return;
        try {
            String name = call.getString("name");
            Long id = modelId(name);
            if (id == null) {
                id = api().addNewCustomModel(name, strings(call.getArray("fields")), strings(call.getArray("cards")),
                    strings(call.getArray("qfmt")), strings(call.getArray("afmt")), call.getString("css"), null, null);
            }
            if (id == null) call.reject("Could not create the note type");
            else call.resolve(new JSObject().put("id", String.valueOf(id)));
        } catch (Exception e) {
            call.reject(message(e), e);
        }
    }

    /** Notes of this note type whose first field equals `key`. */
    @PluginMethod
    public void findDuplicates(PluginCall call) {
        if (!ready(call)) return;
        try {
            JSArray ids = new JSArray();
            Long mid = modelId(call.getString("model"));
            if (mid != null) {
                List<NoteInfo> notes = api().findDuplicateNotes(mid, call.getString("key", ""));
                if (notes != null) for (NoteInfo n : notes) ids.put(String.valueOf(n.getId()));
            }
            call.resolve(new JSObject().put("ids", ids));
        } catch (Exception e) {
            call.reject(message(e), e);
        }
    }

    /** Adds a note; `fields` maps field names to values. The deck is created when missing. */
    @PluginMethod
    public void addNote(PluginCall call) {
        if (!ready(call)) return;
        try {
            AddContentApi api = api();
            String model = call.getString("model");
            Long mid = modelId(model);
            if (mid == null) {
                call.reject("Note type not found in AnkiDroid: " + model);
                return;
            }
            String deck = call.getString("deck", "Default");
            Long did = idByName(api.getDeckList(), deck);
            if (did == null) did = api.addNewDeck(deck);
            if (did == null) {
                call.reject("Could not create the deck " + deck);
                return;
            }
            String[] names = api.getFieldList(mid);
            JSObject fields = call.getObject("fields", new JSObject());
            String[] values = new String[names.length];
            for (int i = 0; i < names.length; i++) values[i] = fields.optString(names[i], "");
            Long id = api.addNote(mid, did, values, tags(call.getArray("tags")));
            if (id == null) call.reject("AnkiDroid did not add the note");
            else call.resolve(new JSObject().put("id", String.valueOf(id)));
        } catch (Exception e) {
            call.reject(message(e), e);
        }
    }

    /** Replaces the given (non-empty) fields of an existing note, keeping the others. */
    @PluginMethod
    public void updateNote(PluginCall call) {
        if (!ready(call)) return;
        try {
            AddContentApi api = api();
            long id = Long.parseLong(call.getString("id", "0"));
            Long mid = modelId(call.getString("model"));
            NoteInfo note = api.getNote(id);
            if (mid == null || note == null) {
                call.reject("Note not found");
                return;
            }
            String[] names = api.getFieldList(mid);
            String[] values = note.getFields();
            JSObject fields = call.getObject("fields", new JSObject());
            for (int i = 0; i < names.length && i < values.length; i++) {
                String v = fields.optString(names[i], "");
                if (!v.isEmpty()) values[i] = v;
            }
            if (api.updateNoteFields(id, values)) call.resolve();
            else call.reject("AnkiDroid did not update the note");
        } catch (Exception e) {
            call.reject(message(e), e);
        }
    }

    /**
     * Copies a file (base64) into AnkiDroid's media folder. Returns the field text AnkiDroid
     * gives for it (<img src="…"> or [sound:…]) and the stored file name.
     */
    @PluginMethod
    public void addMedia(PluginCall call) {
        if (!ready(call)) return;
        File file = null;
        Uri uri = null;
        Context ctx = getContext();
        try {
            String name = call.getString("name", "file");
            String ext = call.getString("ext", "jpg");
            String kind = call.getString("kind", "image");
            File dir = new File(ctx.getCacheDir(), "anki-media");
            dir.mkdirs();
            file = new File(dir, name.replaceAll("[^A-Za-z0-9_\\-]", "_") + "." + ext);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            }
            uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
            ctx.grantUriPermission(ankiPackage(), uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            String tag = api().addMediaFromUri(uri, name, kind);
            if (tag == null) {
                call.reject("AnkiDroid did not store the file");
                return;
            }
            String stored = tag.replaceAll("^<img src=\"|\" ?/?>$|^\\[sound:|\\]$", "");
            call.resolve(new JSObject().put("tag", tag).put("name", stored));
        } catch (Exception e) {
            call.reject(message(e), e);
        } finally {
            if (uri != null) ctx.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (file != null) file.delete();
        }
    }

    /** Brings AnkiDroid to the front. */
    @PluginMethod
    public void open(PluginCall call) {
        try {
            String pkg = ankiPackage();
            Intent intent = pkg == null ? null : getContext().getPackageManager().getLaunchIntentForPackage(pkg);
            if (intent == null) {
                call.reject("AnkiDroid is not installed", "NOT_INSTALLED");
                return;
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject(message(e), e);
        }
    }

    private static String message(Exception e) {
        String m = e.getMessage();
        return e.getClass().getSimpleName() + (m == null ? "" : ": " + m);
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
}
