import os
import unittest
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from paperduo import translation


class TranslationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        settings_patch = patch.object(translation, "settings_path", return_value=Path(directory.name) / "llm-settings.json")
        settings_patch.start()
        self.addCleanup(settings_patch.stop)

    async def test_rejects_other_translation_providers(self):
        for provider in ("libretranslate", "mymemory"):
            with self.assertRaisesRegex(translation.TranslationError, "不支持"):
                await translation.translate_segments(provider, [{"id": "s", "source": "Source."}])

    def test_models_are_configured_choices_and_never_fall_back(self):
        with patch.dict(os.environ, {"TRANSLATION_LLM_BASE_URL": "", "TRANSLATION_LLM_MODEL": "",
                                     "TRANSLATION_LLM_MODELS": "", "LIBRETRANSLATE_URL": "http://offline.test"}):
            self.assertEqual(translation.default_provider(), "academic-llm")
            self.assertFalse(translation.providers()[0]["available"])
            self.assertIsNone(translation.academic_model_config())
        with patch.dict(os.environ, {"TRANSLATION_LLM_BASE_URL": "http://model.test/v1",
                                     "TRANSLATION_LLM_MODEL": "model-a",
                                     "TRANSLATION_LLM_MODELS": " model-b,model-a, ,model-c "}):
            self.assertEqual(translation.configured_models(), ["model-a", "model-b", "model-c"])
            self.assertEqual(translation.academic_model_config("model-b")["model"], "model-b")
            self.assertNotEqual(translation.cache_namespace("academic-llm", "model-a"),
                                translation.cache_namespace("academic-llm", "model-b"))
            with self.assertRaises(translation.TranslationError):
                translation.academic_model_config("unknown")

    async def test_academic_model_translates_related_segments_as_one_context(self):
        response = httpx.Response(200, json={"choices": [{"message": {"content":
            '{"s-1":"该方法取得了良好结果。","s-2":"它还降低了成本。"}'}}]},
            request=httpx.Request("POST", "http://model.test/v1/chat/completions"))
        remote = AsyncMock()
        remote.post.return_value = response
        with patch.dict(os.environ, {"TRANSLATION_LLM_BASE_URL": "http://model.test/v1/",
                                     "TRANSLATION_LLM_MODEL": "default-model",
                                     "TRANSLATION_LLM_MODELS": "academic-model",
                                     "TRANSLATION_LLM_API_KEY": "local-key"}, clear=False), \
             patch.object(translation.httpx, "AsyncClient") as factory:
            factory.return_value.__aenter__ = AsyncMock(return_value=remote)
            factory.return_value.__aexit__ = AsyncMock(return_value=False)
            value = await translation.translate_segments("academic-llm", [
                {"id": "s-1", "source": "The method achieved good results."},
                {"id": "s-2", "source": "It also reduced cost."},
            ], model="academic-model")
        self.assertEqual(value["s-2"], "它还降低了成本。")
        payload = remote.post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], "academic-model")
        self.assertIn('"s-1"', payload["messages"][1]["content"])
        self.assertEqual(remote.post.call_args.kwargs["headers"]["Authorization"], "Bearer local-key")

    async def test_academic_model_rejects_unmatched_segment_ids(self):
        response = httpx.Response(200, json={"choices": [{"message": {"content": '{"wrong":"译文"}'}}]},
            request=httpx.Request("POST", "http://model.test/chat/completions"))
        remote = AsyncMock()
        remote.post.return_value = response
        with patch.dict(os.environ, {"TRANSLATION_LLM_BASE_URL": "http://model.test",
                                     "TRANSLATION_LLM_MODEL": "academic-model"}, clear=False), \
             patch.object(translation.httpx, "AsyncClient") as factory:
            factory.return_value.__aenter__ = AsyncMock(return_value=remote)
            factory.return_value.__aexit__ = AsyncMock(return_value=False)
            with self.assertRaisesRegex(translation.TranslationError, "无法一一对应"):
                await translation.translate_segments("academic-llm", [{"id": "s-1", "source": "Source."}])

    def test_model_cache_namespace_includes_model_and_glossary(self):
        with patch.dict(os.environ, {"TRANSLATION_LLM_BASE_URL": "http://model.test/v1",
                                     "TRANSLATION_LLM_MODEL": "model-a",
                                     "TRANSLATION_GLOSSARY": "graph=图"}, clear=False):
            first = translation.cache_namespace("academic-llm")
            os.environ["TRANSLATION_LLM_MODEL"] = "model-b"
            second = translation.cache_namespace("academic-llm")
        self.assertNotEqual(first, second)

    def test_academic_model_proxy_is_explicit(self):
        with patch.dict(os.environ, {"TRANSLATION_LLM_PROXY": "http://proxy.test:8080"}, clear=False):
            self.assertEqual(translation.academic_model_proxy(), "http://proxy.test:8080")
        with patch.dict(os.environ, {"TRANSLATION_LLM_PROXY": ""}, clear=False):
            self.assertIsNone(translation.academic_model_proxy())


if __name__ == "__main__":
    unittest.main()
