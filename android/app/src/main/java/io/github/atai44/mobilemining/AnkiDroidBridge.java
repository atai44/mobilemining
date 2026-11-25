package io.github.atai44.mobilemining;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.ichi2.anki.api.AddContentApi;
import com.ichi2.anki.api.NoteInfo;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What the app needs from AnkiDroid, on top of its official API (the ContentProvider behind
 * com.ichi2.anki.api.AddContentApi). Plain Java, no Capacitor: used by AnkiDroidPlugin and
 * exercised against a real AnkiDroid by the instrumented test. Call off the UI thread.
 */
public class AnkiDroidBridge {

    public static class AnkiException extends Exception {
        public AnkiException(String message) {
            super(message);
        }
    }

    private final Context ctx;
    private final AddContentApi api;

    public AnkiDroidBridge(Context context) {
        ctx = context;
        api = new AddContentApi(context);
    }

    /** AnkiDroid's package name, or null when it is not installed. */
    public static String ankiPackage(Context context) {
        return AddContentApi.getAnkiDroidPackageName(context);
    }

    private static Long idByName(Map<Long, String> map, String name) {
        if (map == null || name == null) return null;
        for (Map.Entry<Long, String> e : map.entrySet()) if (name.equals(e.getValue())) return e.getKey();
        return null;
    }

    private long modelId(String name) throws AnkiException {
        Long id = idByName(api.getModelList(0), name);
        if (id == null) throw new AnkiException("Note type not found in AnkiDroid: " + name);
        return id;
    }

    public List<String> decks() {
        Map<Long, String> decks = api.getDeckList();
        return decks == null ? new ArrayList<>() : new ArrayList<>(decks.values());
    }

    public List<String> models() {
        Map<Long, String> models = api.getModelList(0);
        return models == null ? new ArrayList<>() : new ArrayList<>(models.values());
    }

    public String[] fields(String model) throws AnkiException {
        String[] names = api.getFieldList(modelId(model));
        return names == null ? new String[0] : names;
    }

    /** The deck's id, creating the deck when it doesn't exist. */
    public long deck(String name) throws AnkiException {
        Long id = idByName(api.getDeckList(), name);
        if (id == null) id = api.addNewDeck(name);
        if (id == null) throw new AnkiException("Could not create the deck " + name);
        return id;
    }

    /** Creates a note type (fields, card names with their front/back templates, CSS) unless it exists. */
    public long addModel(String name, String[] fields, String[] cards, String[] qfmt, String[] afmt, String css) throws AnkiException {
        Long id = idByName(api.getModelList(0), name);
        if (id == null) id = api.addNewCustomModel(name, fields, cards, qfmt, afmt, css, null, null);
        if (id == null) throw new AnkiException("Could not create the note type " + name);
        return id;
    }

    /** Ids of the notes of this note type whose first field equals `key`. */
    public List<Long> findDuplicates(String model, String key) {
        List<Long> ids = new ArrayList<>();
        Long mid = idByName(api.getModelList(0), model);
        if (mid == null) return ids;
        List<NoteInfo> notes = api.findDuplicateNotes(mid, key);
        if (notes != null) for (NoteInfo n : notes) ids.add(n.getId());
        return ids;
    }

    /** Adds a note; `fields` maps field names to values (missing ones stay empty). */
    public long addNote(String model, String deck, Map<String, String> fields, Set<String> tags) throws AnkiException {
        long mid = modelId(model);
        long did = deck(deck);
        String[] names = api.getFieldList(mid);
        String[] values = new String[names.length];
        for (int i = 0; i < names.length; i++) {
            String v = fields.get(names[i]);
            values[i] = v == null ? "" : v;
        }
        Long id = api.addNote(mid, did, values, tags);
        if (id == null) throw new AnkiException("AnkiDroid did not add the note");
        return id;
    }

    /** Field values of a note, in the note type's field order (null when the note doesn't exist). */
    public String[] noteFields(long id) {
        NoteInfo note = api.getNote(id);
        return note == null ? null : note.getFields();
    }

    /** Replaces the given non-empty fields of a note, keeping the others. */
    public void updateNote(long id, String model, Map<String, String> fields) throws AnkiException {
        String[] names = api.getFieldList(modelId(model));
        String[] values = noteFields(id);
        if (values == null) throw new AnkiException("Note not found");
        for (int i = 0; i < names.length && i < values.length; i++) {
            String v = fields.get(names[i]);
            if (v != null && !v.isEmpty()) values[i] = v;
        }
        if (!api.updateNoteFields(id, values)) throw new AnkiException("AnkiDroid did not update the note");
    }

    /**
     * Copies a file into AnkiDroid's media folder and returns the text to put in a field:
     * {@code <img src="…" />} for kind "image", {@code [sound:…]} for kind "audio".
     */
    public String addMedia(String name, String ext, String kind, byte[] data) throws Exception {
        File dir = new File(ctx.getCacheDir(), "anki-media");
        dir.mkdirs();
        // AnkiDroid reads the type from the file extension and names the file after `name`.
        String safe = name.replaceAll("[\\\\/:*?\"<>|\\s]", "_");
        File file = new File(dir, "m" + System.nanoTime() + "." + ext);
        Uri uri = null;
        try {
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(data);
            }
            uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
            ctx.grantUriPermission(ankiPackage(ctx), uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            // Seen once on a fresh install: AnkiDroid stored the first file ever with the extension
            // ".null" (it could not tell the file's type yet). Asking again gives a proper name.
            String tag = null;
            for (int attempt = 0; attempt < 3; attempt++) {
                tag = api.addMediaFromUri(uri, safe, kind);
                if (tag != null && !tag.isEmpty() && !mediaName(tag).endsWith(".null")) return tag;
            }
            if (tag == null || tag.isEmpty()) throw new AnkiException("AnkiDroid did not store the file");
            throw new AnkiException("AnkiDroid could not tell the type of the file (." + ext + ")");
        } finally {
            if (uri != null) ctx.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            file.delete();
        }
    }

    /** The file name inside an addMedia() result. */
    public static String mediaName(String tag) {
        return tag.replaceAll("^<img src=\"|\" ?/?>$|^\\[sound:|\\]$", "");
    }
}
