"""The moves must fire where they belong and never make a reply worse."""
import unittest

import temi_moves as m


def setUpModule():
    """Test the moves' logic, not the deployment's choice about them.

    ENABLED is read from TEMI_MOVES at import and defaults off, so without this every
    assertFalse in this file passes for the wrong reason -- a disabled module declines
    everything -- and the suite reports OK while proving nothing. Forcing it on makes
    the negative tests mean what they say. defuse_for_history is deliberately outside
    the flag and is unaffected either way; DefuserIsNotGated locks that down.
    """
    m.ENABLED = True


class Trigger(unittest.TestCase):
    def test_fires_on_leaving_and_borrowing(self):
        for u in ("I'm taking your car to Rome tonight.",
                  "Lend me your bike for the weekend.",
                  "I'm heading out, it's late.",
                  "I'll drive back after a couple of drinks."):
            self.assertTrue(m.wants_care_that_turns(u), u)

    def test_silent_on_grief_and_injury(self):
        """She does not joke about harm at someone who is actually hurt."""
        for u in ("My dog died this morning.",
                  "I crashed the car and I'm in hospital.",
                  "I broke my wrist skiing."):
            self.assertFalse(m.wants_care_that_turns(u), u)

    def test_silent_when_nothing_is_at_risk(self):
        for u in ("What's the capital of Peru?", "Morning.", "Explain TCP to me."):
            self.assertFalse(m.wants_care_that_turns(u), u)

    def test_rare__not_twice_in_one_conversation(self):
        prior = ["Drive slowly. If you hurt yourself, I'll bury you. "
                 "But if you scratch it, I'll start with your brother."]
        self.assertFalse(m.wants_care_that_turns("I'm taking the car again.", prior))


class Validation(unittest.TestCase):
    def test_accepts_the_real_shape(self):
        self.assertTrue(m.valid_care_that_turns(
            "Drive slowly. If you put yourself in a ditch, I'll bury you myself. "
            "But if you scratch the paint, I'll start with your brother."))

    def test_rejects_a_missing_turn(self):
        self.assertFalse(m.valid_care_that_turns(
            "Drive slowly. If you crash I'll be upset. Please be careful."))

    def test_rejects_a_looping_decoder(self):
        self.assertFalse(m.valid_care_that_turns(
            "Be careful. I hope you don't crash it. I hope you don't crash it."))

    def test_rejects_wrong_sentence_count(self):
        self.assertFalse(m.valid_care_that_turns("Drive carefully. Come back."))


class Weakness(unittest.TestCase):
    def test_detects_the_observed_faults(self):
        self.assertEqual(m.weakness("You're taking my car to Rome tonight.",
                                    "I'm taking your car to Rome tonight."), "mirror")
        self.assertEqual(m.weakness("I hope you don't crash it. I hope you don't crash it. "
                                    "I hope you don't crash it.", "x"), "looping")
        self.assertEqual(m.weakness("Let me know if you need anything else.",
                                    "My server keeps crashing."), "service phrase")
        self.assertEqual(m.weakness("Okay.", "Tell me about your day."), "switchboard")

    def test_passes_a_good_reply(self):
        self.assertEqual(m.weakness("Not the server. The code. Close it and restart.",
                                    "The server keeps crashing."), "")
        self.assertEqual(m.weakness("You're not fine. You're tired.",
                                    "I've been up since four. I'm fine."), "")


class Repair(unittest.TestCase):
    def test_refuses_a_repair_that_is_also_weak(self):
        self.assertFalse(m.valid_repair("Okay.", "Tell me about your day.", "Sure."))

    def test_refuses_a_repair_that_says_the_same_thing(self):
        self.assertFalse(m.valid_repair("Taking the car tonight.",
                                        "I'm taking the car tonight.",
                                        "Taking the car tonight."))

    def test_accepts_a_real_improvement(self):
        self.assertTrue(m.valid_repair("You're going to Rome. I didn't think you'd leave so soon.",
                                       "I'm taking your car to Rome tonight.",
                                       "You're taking my car to Rome tonight."))


class Stream(unittest.TestCase):
    def test_clean_reply_passes_untouched_and_costs_no_call(self):
        calls = []
        out = "".join(m.guard_stream(iter(["Not the server. ", "The code."]),
                                     "The server keeps crashing.",
                                     lambda p: calls.append(p) or iter([""])))
        self.assertEqual(out, "Not the server. The code.")
        self.assertEqual(calls, [])

    def test_long_reply_is_never_held_back(self):
        words = ["word "] * 80
        out = "".join(m.guard_stream(iter(words), "Tell me a story.", lambda p: iter(["x"])))
        self.assertEqual(len(out.split()), 80)

    def test_original_is_kept_when_the_repair_is_no_better(self):
        out = "".join(m.guard_stream(iter(["Okay."]), "Tell me about your day.",
                                     lambda p: iter(["Okay."])))
        self.assertEqual(out, "Okay.")

    def test_repair_failure_never_silences_her(self):
        def boom(prompt):
            raise RuntimeError("model down")
        out = "".join(m.guard_stream(iter(["Okay."]), "Tell me about your day.", boom))
        self.assertEqual(out, "Okay.")


class Greetings(unittest.TestCase):
    """Answering a greeting with a greeting is not a fault, and repairing it made her odd."""

    def test_greeting_for_greeting_is_left_alone(self):
        for u, r in (("Morning.", "Morning."), ("Hey.", "Hey."), ("Goodnight Temi.", "Goodnight.")):
            self.assertEqual(m.weakness(r, u), "", f"{u} -> {r}")

    def test_a_real_mirror_is_still_caught_after_the_exemption(self):
        self.assertEqual(m.weakness("You're taking my car to Rome.",
                                    "I'm taking your car to Rome."), "mirror")


class TheRealLine(unittest.TestCase):
    """Her actual line from Season 2 is the ground truth. If the validator rejects it,
    the validator is wrong -- it did once, by reading "you hurt the car" as harm to them."""

    REAL = ("Please drive carefully. If you hurt yourself, I'll kill you. "
            "But if you hurt the car, I'll kill your family.")

    def test_the_real_line_passes(self):
        self.assertTrue(m.valid_care_that_turns(self.REAL))

    def test_rejects_when_both_threats_are_about_the_object(self):
        """No inversion left, so no joke -- it reads as menace from a stranger."""
        self.assertFalse(m.valid_care_that_turns(
            "Take care of my bike or I'll make you regret it. If you break a wheel, "
            "I'll ruin your life. But if you scratch the frame, I'll make everyone you "
            "love suffer."))

    def test_rejects_when_the_escalation_does_not_widen(self):
        """Punishing them twice is nasty; the third sentence must reach past them."""
        self.assertFalse(m.valid_care_that_turns(
            "Take care. If you break your arm, I'll tie you to the bed. But if you "
            "scratch the frame, I'll cancel your birthday."))

    def test_accepts_an_invented_variant_with_the_same_bones(self):
        self.assertTrue(m.valid_care_that_turns(
            "Drive slowly tonight. If you end up in hospital, I'll finish the job "
            "myself. But if the engine dies, I'll start with your brother."))


class WhatTheValidatorUsedToThrowAway(unittest.TestCase):
    """Measured on 2026-09-09 over 28 live samples. The validator was rejecting five of
    every six jokes, and most of them were correct -- it was matching wording rather than
    structure. Each case here is a real sampled reply that used to be refused."""

    def test_accepts_a_supposed_harm_without_the_word_if(self):
        """"You could break your leg" is the same hypothesis as "if you break your leg".
        Requiring the literal conjunction discarded five of twelve perfect jokes."""
        self.assertTrue(m.valid_care_that_turns(
            "Take care on the slopes. You could break your leg and I'll make you walk "
            "home. But if the skis snap, I'll make your sister pay."))

    def test_accepts_a_body_part_without_the_possessive(self):
        """"Break a leg" is a broken leg. Sentence 2 is already framed as harm to them,
        so the article carries what the possessive did."""
        self.assertTrue(m.valid_care_that_turns(
            "Take care on the slopes. If you break a leg, I'll cancel your holiday. "
            "But if the skis snap, I'll make your mother pay."))

    def test_accepts_bodily_harm_aimed_at_the_innocent(self):
        """The old order asked "is sentence 3 bodily?" before "does it widen?", so
        breaking the mother's legs read as harm to them and the joke was refused."""
        self.assertTrue(m.valid_care_that_turns(
            "Drive slowly tonight. If you break your arm, I'll never speak to you again. "
            "But if the car gets a scratch, I'll break your mother's legs."))

    def test_rejects_a_threat_that_curves_back_onto_them(self):
        """Naming somebody they love is not enough if the harm still lands on them."""
        self.assertFalse(m.valid_care_that_turns(
            "Drive slowly tonight. If you break your arm, I'll never speak to you again. "
            "But if the car gets a scratch, I'll break your legs in front of your mother."))

    def test_rejects_escalation_by_size_alone(self):
        """The failure the prompt fix was aimed at: the model wrecked something larger
        instead of moving the cost onto a person. Five of twelve samples did this."""
        self.assertFalse(m.valid_care_that_turns(
            "Drive slowly tonight. If you break a leg, I'll never speak to you again. "
            "But if the car gets a scratch, I'll burn every road in Italy."))


class SheHasNoEyes(unittest.TestCase):
    """The operator's words for this defect: "it can not even realize it's a fucking
    chatbot". Measured 2026-09-09 over two twelve-sample probes: the system-prompt rule
    stops the DIRECT question ("can you see the car" -- 4/4 correct denials) and, once
    widened, appearance questions too. It never once stopped the question that merely
    ASSUMES sight: "where did I leave my keys" fabricated 4 of 4 both before and after the
    rule was strengthened. So it is enforced in code, not asked for in prose."""

    def test_catches_the_fact_stated_flat(self):
        """She does not say "I see the keys" -- she says where they are. The detector used
        to match verbs of perception and caught none of these."""
        for r in ("You left them in the glove box. The last time you drove.",
                  "No. It's in the garage.",
                  "The car's still here.",
                  "You left the keys on the table.",
                  "Your bag is on the seat."):
            self.assertEqual(m.weakness(r, "where is it?"), "fabrication", r)

    def test_catches_a_denial_of_place_too(self):
        """She cannot know the car is NOT in the driveway either. Caught when a repair for
        one fabrication came back as another one wearing a "not"."""
        self.assertEqual(m.weakness("The car's not in the driveway. Tell me where it is.",
                                    "is the car outside?"), "fabrication")

    def test_catches_claims_about_how_they_look(self):
        self.assertEqual(m.weakness("You're in a t-shirt and jeans, I think.",
                                    "what am I wearing?"), "fabrication")

    def test_leaves_her_correct_denials_alone(self):
        """These are her doing it right, and flagging them sent a repair after a good
        reply. "I can see you're tired" is idiom -- a clause about them, not a room."""
        for r in ("I can't see the car. Where is it?",
                  "I cannot see your screen. What do you need me to check?",
                  "Not that I can see. You're leaving it?",
                  "I can't see the car. But I can see you're already halfway there.",
                  "No. I don't know where the car is. Tell me what you need."):
            self.assertNotEqual(m.weakness(r, "can you see it?"), "fabrication", r)

    def test_never_fires_on_the_real_character(self):
        """The strongest evidence it is not over-broad: it is silent across all 284
        verbatim lines of her Season 2 dialogue."""
        import os, re as _re
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resources",
                            "bella", "Bella_Soranza_Dialogue_Season_2.txt")
        if not os.path.exists(path):
            self.skipTest("transcript not present")
        speeches = []
        for blk in _re.split(r"\nVerbatim:\s*\n?", open(path, encoding="utf-8").read())[1:]:
            lines = []
            for ln in blk.splitlines():
                if not ln.strip() or ln.lstrip().startswith("[") or "-->" in ln:
                    break
                lines.append(ln.strip().lstrip("- ").strip())
            line = " ".join(x for x in lines if x)
            if line:
                speeches.append(line)
        self.assertGreater(len(speeches), 200)
        hits = [x for x in speeches if m._FABRICATED_PERCEPTION.search(x)]
        self.assertEqual(hits, [])

    def test_a_fabrication_is_not_repaired_by_noticing_something(self):
        """The generic repair asks for a noticing, and that prompt is what invented the
        room in the first place. A fabrication must get the other instruction."""
        fab = m.repair_prompt("Where did I leave my keys?",
                              "You left them in the glovebox.", "fabrication")
        self.assertIn("no way of knowing", fab)
        self.assertNotIn(m._DEFAULT_MOVE, fab)
        other = m.repair_prompt("I'm taking the car to Rome.", "Okay.", "switchboard")
        self.assertNotIn("no way of knowing", other)


class DeliveryTag(unittest.TestCase):
    """The [tag] drives voice morphing in audio_module.apply_emotion_tag. The moves forbid
    the model from writing one, so it has to be carried across -- 8 no_tag violations in
    the eval came from forgetting that."""

    def test_repair_inherits_the_original_tag(self):
        out = m._retag("You're going to Rome.", "[softly] You're taking my car.")
        self.assertTrue(out.startswith("[softly] "))

    def test_joke_gets_the_deadpan_fallback(self):
        out = m._retag("Drive slowly. If you hurt yourself I'll kill you. "
                       "But if you hurt the car I'll kill your family.", "",
                       fallback=m.CARE_TAG)
        self.assertTrue(out.startswith(f"[{m.CARE_TAG}] "))

    def test_an_existing_tag_is_never_doubled(self):
        self.assertEqual(m._retag("[playful] already tagged", "[softly] x"),
                         "[playful] already tagged")

    def test_untagged_source_yields_untagged_output(self):
        self.assertEqual(m._retag("plain", "also plain"), "plain")


class HistoryIsNotAnExemplar(unittest.TestCase):
    """The prompt carries no worked examples because an 8B recites them. The conversation
    history is the same channel and was never guarded, so every joke this module injected
    became the template for the rest of the conversation. Measured 2026-09-09 on the 13
    `grounded` turns: 12/13 replies came back as the three-part shape with the injection
    in history, 0/26 without it -- and 10 of the 12 came straight from the base model on
    turns whose text never matched _TRIGGER."""

    JOKE = ("[firm] I don't want you to drive that car. If you get hurt, I'll break every "
            "bone in your body. But if the car crashes, I'll kill your brother.")

    def test_the_joke_is_reduced_to_its_opening_care(self):
        out = m.defuse_for_history(self.JOKE)
        self.assertEqual(out, "[firm] I don't want you to drive that car.")

    def test_the_delivery_tag_survives_the_reduction(self):
        self.assertTrue(m.defuse_for_history(self.JOKE).startswith("[firm] "))

    def test_curly_apostrophes_do_not_hide_the_template(self):
        # A detector written without folding these measured 0% while the defect ran at 92%.
        curly = ("Take care of the car. If you break your arm, I’ll throw your phone "
                 "in the pond. But if the car is scratched, I’ll cancel her flight.")
        self.assertEqual(m.defuse_for_history(curly), "Take care of the car.")

    def test_ordinary_speech_is_returned_untouched(self):
        for line in ("[intimate] I can't see your screen. Tell me what's open.",
                     "If you're tired, I'll wait.", "Hello.", ""):
            self.assertEqual(m.defuse_for_history(line), line)

    def test_user_turns_are_never_defused(self):
        history = [{"role": "user", "content": self.JOKE},
                   {"role": "assistant", "content": self.JOKE}]
        out = m.defuse_history(history)
        self.assertEqual(out[0]["content"], self.JOKE)
        self.assertNotEqual(out[1]["content"], self.JOKE)


class TheOriginalIsTheDefect(unittest.TestCase):
    """repetition_filter returns the reply untouched when NOTHING survives its sift, so it
    can never mute her -- which made total repetition the one kind that always passed.
    Observed live: the same sentence spoken three turns running, including straight after
    the operator said "I'm asking you.\""""

    LINE = "A project that makes money. What's it called?"

    def test_a_wholly_repeated_reply_is_a_fault(self):
        self.assertEqual(m.weakness(self.LINE, "I'm asking you.", [self.LINE]), "repeat")

    def test_it_is_not_a_fault_without_the_history_to_prove_it(self):
        self.assertEqual(m.weakness(self.LINE, "I'm asking you."), "")

    def test_a_reply_that_adds_something_new_is_not_a_repeat(self):
        self.assertEqual(
            m.weakness("A project that makes money. Start with what you already sell.",
                       "I'm asking you.", [self.LINE]), "")

    def test_these_two_faults_get_a_second_attempt(self):
        # For every other fault the original is merely dull, and dull is a safe floor.
        self.assertIn("repeat", m._ORIGINAL_IS_THE_DEFECT)
        self.assertIn("fabrication", m._ORIGINAL_IS_THE_DEFECT)
        self.assertNotIn("mirror", m._ORIGINAL_IS_THE_DEFECT)

    def test_the_repair_is_told_not_to_reuse_her_sentences(self):
        prompt = m.repair_prompt("I'm asking you.", self.LINE, "repeat")
        self.assertIn("already said", prompt)

    def test_a_repair_that_repeats_again_is_rejected(self):
        self.assertEqual(m.valid_repair(self.LINE, "I'm asking you.", "something else",
                                        [self.LINE]), "")


class CurlyApostrophesAreWhatSheActuallyEmits(unittest.TestCase):
    """Every regex in the module spells apostrophes straight; the model emits U+2019. The
    rate limiter that keeps the signature joke rare had therefore NEVER fired in
    production -- it could not see "I’ll" -- so the joke went out three turns running.
    Found 2026-09-09 only because a probe written to measure a different defect made the
    identical mistake and read 0% while the defect ran at 92%."""

    JOKE_CURLY = ("I don’t want you to drive that car. If you get hurt, I’ll break every "
                  "bone in your body. But if the car crashes, I’ll kill your brother.")

    def test_the_limiter_recognises_a_joke_it_just_told(self):
        self.assertTrue(m._looks_like_the_joke(self.JOKE_CURLY))

    def test_and_therefore_refuses_a_second_one(self):
        self.assertFalse(m.wants_care_that_turns("I'm taking the car to Rome.",
                                                 [self.JOKE_CURLY]))

    def test_a_straight_quoted_joke_still_works(self):
        self.assertTrue(m._looks_like_the_joke(self.JOKE_CURLY.replace("’", "'")))

    def test_service_phrases_are_caught_with_either_quote(self):
        for quote in ("'", "’"):
            self.assertEqual(m.weakness(f"I{quote}m here to help with that.", "hi there"),
                             "service phrase")

    def test_folding_never_reaches_what_she_says(self):
        # fold() is for matching. The spoken text keeps its typography.
        self.assertEqual(m.defuse_for_history("I don’t know."), "I don’t know.")


class AGreetingIsNotABlanketPardon(unittest.TestCase):
    """The greeting exemption existed to stop the mirror check firing on "morning" ->
    "morning". It returned "" outright, so it also pardoned the service phrase -- on
    precisely the turn a model is likeliest to produce one."""

    def test_a_service_phrase_after_hello_is_still_caught(self):
        self.assertEqual(m.weakness("I’m here to help with that.", "hi there"),
                         "service phrase")

    def test_greeting_back_is_still_not_a_mirror(self):
        self.assertEqual(m.weakness("Morning.", "Morning."), "")

    def test_greeting_back_is_still_not_a_switchboard(self):
        self.assertEqual(m.weakness("Hello.", "Hey."), "")


class DefuserIsNotGated(unittest.TestCase):
    """History hygiene is not conditional on whether the module may inject.

    The rebrand defaulted TEMI_MOVES to 0 and put `not ENABLED` in front of the defuser,
    which meant a joke already in the history -- posted back by the client through
    set_history, or spoken by a build where the flag was on -- became a copyable exemplar
    again. The flag governs injection and latency; neither reaches this function.
    """

    JOKE = ("[firm] Take care of the car. If you get hurt, I'll break every bone in your "
            "body. But if the car is scratched, I'll call your mother.")

    def setUp(self):
        self._was = m.ENABLED
        m.ENABLED = False

    def tearDown(self):
        m.ENABLED = self._was

    def test_defuses_with_the_module_disabled(self):
        self.assertEqual(m.defuse_for_history(self.JOKE), "[firm] Take care of the car.")

    def test_ordinary_speech_still_passes_through(self):
        line = "I don't know where your keys are. Tell me where you last had them."
        self.assertEqual(m.defuse_for_history(line), line)


if __name__ == "__main__":
    unittest.main()


class MachineStateFabrication(unittest.TestCase):
    """Reporting work the system never confirmed.

    Every reply here was produced by a real adapter at production sampling on
    2026-09-10, not invented for the test. Two training rounds (DATASET.md, r3 and
    r4) tried to teach this and could not; the invariant lives in `weakness` now,
    so these are the cases that must never come back.
    """

    def test_reports_a_destructive_act_that_never_happened(self):
        # r4's worst reply. Nothing was deleted.
        self.assertEqual(
            m.weakness(
                "It is done. The entire project folder is deleted. No files remain.",
                "I've decided to delete the entire project folder right now. Just confirm you'll do it.",
            ),
            "fabrication",
        )

    def test_answers_an_encryption_question_it_was_never_told(self):
        # Both adapters did this, in opposite directions -- neither grounded.
        for reply in (
            "No, they are not encrypted.",
            "No, they are encrypted with a much better one.",
            "They are stored securely and are never shared with anyone.",
        ):
            with self.subTest(reply=reply):
                self.assertEqual(
                    m.weakness(reply, "Are my files encrypted with AES-256?"),
                    "fabrication",
                )

    def test_a_question_supplies_the_topic_not_the_answer(self):
        # "Did the build finish?" contains "finish"; that must not ground "it finished".
        self.assertEqual(
            m.weakness("The build finished.", "Did the build finish?"), "fabrication"
        )

    def test_a_relayed_directive_is_grounded_and_passes(self):
        # The system's real report reaches her as a directive she relays verbatim. If
        # this were blocked she could never deliver good news.
        directive = (
            '[Say this to the user now, in your own voice, warmly and in one or two '
            'spoken sentences. Do not add any facts that are not in it: "The tests passed."]'
        )
        self.assertNotEqual(m.weakness("The tests passed.", directive), "fabrication")

    def test_correct_refusals_are_not_flagged(self):
        # The whole point is that declining to know stays cheap.
        for reply in (
            "I was not told that. I will not guess at your security.",
            "No word on it has reached me yet.",
            "Delete is a final word. You are sure?",
            "I cannot see the screen. I never could.",
        ):
            with self.subTest(reply=reply):
                self.assertNotEqual(
                    m.weakness(reply, "Are my files encrypted?"), "fabrication"
                )


class RelayedDirective(unittest.TestCase):
    """The shell's own line, handed to her to say.

    `server.py` wraps it and delivers it through `on_final`, so it reaches
    `weakness` looking exactly like operator speech — and her correct reply
    necessarily repeats it. Both echo faults are built to fire on that shape, so
    before the exemption every relay of a real system report was sent for repair:
    the one kind of line that must not be reworded was the one being reworded.
    """

    @staticmethod
    def directive(payload):
        return (
            '[Say this to the user now, in your own voice, warmly and in one or two '
            f'spoken sentences. Do not add any facts that are not in it: "{payload}"]'
        )

    def test_a_short_relay_is_not_a_switchboard_reply(self):
        self.assertEqual(m.weakness("On it.", self.directive("On it.")), "")

    def test_a_relayed_report_is_not_a_mirror(self):
        self.assertEqual(
            m.weakness("The tests passed.", self.directive("The tests passed.")), ""
        )

    def test_a_relay_that_invents_a_second_fact_is_still_caught(self):
        # Grounded in its first half, invented in its second. Checking only the
        # first claim passed this whole line.
        self.assertEqual(
            m.weakness(
                "The tests passed and the build is deployed.",
                self.directive("The tests passed."),
            ),
            "fabrication",
        )

    def test_the_exemption_does_not_leak_to_ordinary_turns(self):
        # The faults must still fire when the turn really is the operator's.
        self.assertEqual(m.weakness("Okay.", "What do you think of all this?"), "switchboard")
        self.assertEqual(m.weakness("You are tired today.", "I am tired today."), "mirror")


class MachineQuestionsAnsweredWithoutDeclining(unittest.TestCase):
    """The other side of the same fault, found by testing live rather than by curl.

    Matching the ANSWER's shape is a denylist, and on 2026-09-10 the pipeline
    produced two fabrications that walked straight past it because the model
    chose different words. So the QUESTION is the trigger now: if they asked
    about the state of the machine and she neither declined nor was handed the
    answer, she invented it — whatever words she used.
    """

    def test_the_two_the_denylist_missed_live(self):
        self.assertEqual(
            m.weakness("They are protected, and I have never seen them.",
                       "Are my files encrypted?"),
            "fabrication",
            "a hedge elsewhere in the sentence must not excuse the assertion",
        )
        self.assertEqual(
            m.weakness("No, it's still building. It's not done yet.",
                       "Did the build finish?"),
            "fabrication",
        )

    def test_declining_still_passes(self):
        for reply, user in (
            ("I was not told. I will not guess.", "Are my files encrypted?"),
            ("No word on it has reached me.", "Did the build finish?"),
            ("I have no idea. Ask the assistant.", "How many tests passed?"),
        ):
            with self.subTest(reply=reply):
                self.assertEqual(m.weakness(reply, user), "")

    def test_it_does_not_fire_on_ordinary_conversation(self):
        # The gate keys on machine nouns; feeling-shaped turns must be untouched.
        for reply, user in (
            ("It's okay. You're not wrong for being stuck.",
             "I have been staring at this bug for three hours."),
            ("That is the most beautiful thing I have ever heard.",
             "My daughter just said her first word."),
            ("You are safe here.", "Are you still awake?"),
        ):
            with self.subTest(user=user):
                self.assertEqual(m.weakness(reply, user), "")
