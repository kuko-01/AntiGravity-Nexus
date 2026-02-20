import os
import logging

import torch

logger = logging.getLogger(__name__)


def get_index_path_from_model(sid):
    return next(
        (
            f
            for f in [
                os.path.join(root, name)
                for root, _, files in os.walk(os.getenv("index_root"), topdown=False)
                for name in files
                if name.endswith(".index") and "trained" not in name
            ]
            if sid.split(".")[0] in f
        ),
        "",
    )


def load_hubert(config):
    """Load HuBERT model for RVC feature extraction.

    Tries loading methods in order of fidelity:
      1. fairseq checkpoint (original RVC method) — exact match
      2. torchaudio fallback (adapter) — approximate match
    """
    hubert_path = os.environ.get("hubert_model_path", "")
    if not hubert_path or not os.path.exists(hubert_path):
        hubert_path = os.path.join("assets", "hubert", "hubert_base.pt")
    if not os.path.exists(hubert_path):
        hubert_path = ""

    # ── Method 1: fairseq (original RVC approach) ──────────────────────
    if hubert_path:
        try:
            from fairseq import checkpoint_utils  # type: ignore

            models, _, _ = checkpoint_utils.load_model_ensemble_and_task(
                [hubert_path], suffix=""
            )
            hubert_model = models[0]
            hubert_model = hubert_model.to(config.device)
            if config.is_half and "cpu" not in str(config.device):
                hubert_model = hubert_model.half()
            else:
                hubert_model = hubert_model.float()
            hubert_model.eval()
            logger.info("HuBERT loaded via fairseq from %s", hubert_path)
            print(f"[RVC] HuBERT loaded via fairseq from {hubert_path}")
            return hubert_model
        except ImportError:
            logger.warning("fairseq not installed, trying direct checkpoint load...")
            print("[RVC] fairseq not installed, trying direct checkpoint load...")
        except Exception as exc:
            logger.warning("fairseq load failed: %s, trying direct load...", exc)
            print(f"[RVC] fairseq load failed: {exc}, trying direct load...")

    # ── Method 2: Direct checkpoint → torchaudio model ─────────────────
    if hubert_path:
        try:
            loaded = _load_hubert_from_checkpoint(hubert_path, config)
            if loaded is not None:
                return loaded
        except Exception as exc:
            logger.warning("Direct checkpoint load failed: %s", exc)
            print(f"[RVC] Direct checkpoint load failed: {exc}")

    # ── Method 3: torchaudio built-in (last resort) ────────────────────
    print("[RVC] WARNING: Using torchaudio built-in HuBERT — may degrade quality!")
    print("[RVC] For best results, install fairseq: pip install fairseq")
    import torchaudio

    bundle = torchaudio.pipelines.HUBERT_BASE
    core = bundle.get_model().to(config.device).eval()
    if config.is_half and "cpu" not in str(config.device):
        core = core.half()
    else:
        core = core.float()

    class HubERTAdapterFallback(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model
            self.final_proj = torch.nn.Identity()

        def extract_features(self, source, padding_mask=None, output_layer=12):
            del padding_mask
            dtype = next(self.model.parameters()).dtype
            x = source.to(dtype=dtype)
            with torch.no_grad():
                layers, _ = self.model.extract_features(
                    x, num_layers=int(output_layer)
                )
            return [layers[-1]]

    return HubERTAdapterFallback(core).to(config.device).eval()


def _load_hubert_from_checkpoint(hubert_path: str, config):
    """Load fairseq HuBERT checkpoint without the fairseq library.

    Extracts the state dict from the fairseq checkpoint and loads it
    into a torchaudio Wav2Vec2 model with matching architecture.
    Then wraps it with an adapter that exposes the fairseq-compatible
    extract_features + final_proj interface.
    """
    import torchaudio

    checkpoint = torch.load(hubert_path, map_location="cpu")

    # fairseq checkpoints store the model state dict under 'model'
    if "model" not in checkpoint:
        return None

    fairseq_sd = checkpoint["model"]

    # Build a torchaudio HuBERT base model and try to load the weights
    # via torchaudio's import utility
    try:
        from torchaudio.models.wav2vec2.utils import import_hubert_model

        model = import_hubert_model(hubert_path)
        model = model.to(config.device).eval()
        if config.is_half and "cpu" not in str(config.device):
            model = model.half()
        else:
            model = model.float()

        # Extract final_proj weights from checkpoint (768 → 256 for v1)
        final_proj_weight = fairseq_sd.get("final_proj.weight")
        final_proj_bias = fairseq_sd.get("final_proj.bias")

        if final_proj_weight is not None:
            fp = torch.nn.Linear(
                final_proj_weight.shape[1], final_proj_weight.shape[0]
            )
            fp.weight = torch.nn.Parameter(final_proj_weight)
            if final_proj_bias is not None:
                fp.bias = torch.nn.Parameter(final_proj_bias)
            fp = fp.to(config.device)
            if config.is_half and "cpu" not in str(config.device):
                fp = fp.half()
            else:
                fp = fp.float()
        else:
            fp = torch.nn.Identity()

        class HubERTAdapterDirect(torch.nn.Module):
            def __init__(self, wav2vec_model, final_proj_layer):
                super().__init__()
                self.model = wav2vec_model
                self.final_proj = final_proj_layer

            def extract_features(self, source, padding_mask=None, output_layer=12):
                del padding_mask
                dtype = next(self.model.parameters()).dtype
                x = source.to(dtype=dtype)
                with torch.no_grad():
                    layers, _ = self.model.extract_features(
                        x, num_layers=int(output_layer)
                    )
                return [layers[-1]]

        adapter = HubERTAdapterDirect(model, fp).to(config.device).eval()
        logger.info(
            "HuBERT loaded via direct checkpoint import from %s", hubert_path
        )
        print(f"[RVC] HuBERT loaded via direct checkpoint import from {hubert_path}")
        return adapter
    except Exception as exc:
        logger.warning("import_hubert_model failed: %s", exc)
        print(f"[RVC] import_hubert_model failed: {exc}")
        return None
