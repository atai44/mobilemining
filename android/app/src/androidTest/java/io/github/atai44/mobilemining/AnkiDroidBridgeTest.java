package io.github.atai44.mobilemining;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;

/**
 * Runs the app's AnkiDroid code against a real AnkiDroid on the device:
 *   adb shell pm grant io.github.atai44.mobilemining com.ichi2.anki.permission.READ_WRITE_DATABASE
 *   ./gradlew connectedDebugAndroidTest
 */
@RunWith(AndroidJUnit4.class)
public class AnkiDroidBridgeTest {

    // 1x1 JPEG and a few bytes with an MP3 header: AnkiDroid only looks at the type
    private static final byte[] JPEG = Base64.decode("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=", Base64.DEFAULT);
    private static final byte[] MP3 = new byte[] { (byte) 0xFF, (byte) 0xFB, (byte) 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };

    @Test
    public void addsNotesWithMediaAndFindsDuplicates() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertNotNull("AnkiDroid is installed", AnkiDroidBridge.ankiPackage(ctx));
        AnkiDroidBridge anki = new AnkiDroidBridge(ctx);

        // Note type and deck
        String model = "MobileMining Test " + System.currentTimeMillis();
        String[] fields = { "Word", "Reading", "Sentence", "Picture", "Audio" };
        anki.addModel(model, fields, new String[] { "Card 1" }, new String[] { "{{Sentence}}" }, new String[] { "{{FrontSide}}<hr id=answer>{{Word}}{{Audio}}{{Picture}}" }, ".card { font-size: 20px; }");
        assertTrue("note type listed: " + anki.models(), anki.models().contains(model));
        assertArrayEquals(fields, anki.fields(model));
        String deck = "MobileMining::Test";
        anki.deck(deck);
        assertTrue("deck listed: " + anki.decks(), anki.decks().contains(deck));

        // Media
        String img = anki.addMedia("mobilemining_test", "jpg", "image", JPEG);
        String snd = anki.addMedia("mobilemining_よむ_読む", "mp3", "audio", MP3);
        Log.i("MMTest", "media: " + img + " " + snd);
        assertTrue(img, img.matches("<img src=\"mobilemining_test[^\"]*\\.jpe?g\" />"));
        assertTrue(snd, snd.matches("\\[sound:mobilemining_よむ_読む[^\\]]*\\.mp3\\]"));
        assertTrue(AnkiDroidBridge.mediaName(img), AnkiDroidBridge.mediaName(img).matches("mobilemining_test[^\"<> ]*\\.jpe?g"));

        // Add
        assertEquals(0, anki.findDuplicates(model, "読む").size());
        Map<String, String> values = new HashMap<>();
        values.put("Word", "読む");
        values.put("Reading", "よむ");
        values.put("Sentence", "昨日は本を<b>読まなかった</b>。");
        values.put("Picture", "<img src=\"" + AnkiDroidBridge.mediaName(img) + "\">");
        values.put("Audio", snd);
        long id = anki.addNote(model, deck, values, new HashSet<>(Arrays.asList("mobilemining", "test")));
        assertArrayEquals(new String[] { "読む", "よむ", "昨日は本を<b>読まなかった</b>。", values.get("Picture"), snd }, anki.noteFields(id));

        // Still there? (a made-up id is not)
        assertEquals(Arrays.asList(id), anki.existing(Arrays.asList(id, 1234567890123L)));

        // Duplicates, update
        List<Long> dupes = anki.findDuplicates(model, "読む");
        assertEquals(Arrays.asList(id), dupes);
        Map<String, String> update = new HashMap<>();
        update.put("Sentence", "本を<b>読む</b>。");
        update.put("Reading", "");
        anki.updateNote(id, model, update);
        assertArrayEquals(new String[] { "読む", "よむ", "本を<b>読む</b>。", values.get("Picture"), snd }, anki.noteFields(id));
        Log.i("MMTest", "note " + id + " ok: " + Arrays.toString(anki.noteFields(id)));
    }
}
