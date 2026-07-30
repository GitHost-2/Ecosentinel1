"""
EcoSentinel — Validador de artefactos (correr en el RPi antes de inferir)
==========================================================================
Verifica que los 4 .pkl carguen correctamente y sean compatibles
con la version de scikit-learn instalada en el RPi.

Uso:  python3 validate_artifacts.py
"""
import sys
from pathlib import Path
import warnings
import joblib
import numpy as np

# Capturar warnings de version de sklearn (InconsistentVersionWarning)
# para avisar claramente si el .pkl se entreno con otra version
warnings.filterwarnings("error", category=UserWarning, module="sklearn")

try:
    import sklearn
    SKLEARN_VER = sklearn.__version__
except ImportError:
    print("  [ERROR] scikit-learn no esta instalado en el RPi.")
    print("  Ejecuta: pip install scikit-learn --prefer-binary")
    sys.exit(1)

MODEL_DIR = Path(__file__).resolve().parent / "models"
files = {
    "modelo":    MODEL_DIR / "ecosentinel_model_rpi.pkl",
    "umbral":    MODEL_DIR / "optimal_threshold_rpi.pkl",
    "scaler":    MODEL_DIR / "scaler.pkl",
    "features":  MODEL_DIR / "selected_features.pkl",
}

print("=" * 55)
print("  EcoSentinel — Validacion de artefactos")
print(f"  scikit-learn instalado: {SKLEARN_VER}")
print("=" * 55)

ok = True
version_warning = False
for name, path in files.items():
    if not path.exists():
        print(f"  [FALTA]  {name}: {path}")
        ok = False
    else:
        try:
            obj = joblib.load(path)
            print(f"  [OK]     {name}: {type(obj).__name__}")
        except UserWarning as w:
            # sklearn avisa si el .pkl se entreno con otra version
            print(f"  [AVISO]  {name}: entrenado con otra version de sklearn")
            print(f"           {w}")
            version_warning = True
            # recargar ignorando el warning para seguir validando
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                obj = joblib.load(path)
        except Exception as e:
            print(f"  [ERROR]  {name}: {e}")
            ok = False

if not ok:
    print("\n  Faltan artefactos o hay errores de carga. Revisa arriba.")
    sys.exit(1)

# Prueba de inferencia end-to-end con datos ficticios
print("\n  Probando inferencia end-to-end...")
with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    model     = joblib.load(files["modelo"])
    threshold = joblib.load(files["umbral"])
    scaler    = joblib.load(files["scaler"])
    features  = joblib.load(files["features"])

n = len(features)
fake = np.random.rand(1, n).astype(np.float32)
try:
    scaled = scaler.transform(fake)
    prob = model.predict_proba(scaled)[0, 1]
    decision = "ATTACK" if prob >= threshold else "BENIGN"
    print(f"  [OK]     Vector de {n} features -> prob={prob:.3f} -> {decision}")
    print(f"\n  Todo listo. El motor de inferencia puede correr.")
    if version_warning:
        print(f"\n  NOTA: hubo un aviso de version de sklearn. El modelo cargo y")
        print(f"  funciona, pero para evitar comportamiento inesperado conviene")
        print(f"  igualar la version a la usada al entrenar en la laptop.")
except Exception as e:
    print(f"  [ERROR]  Fallo la inferencia: {e}")
    print(f"  Probable causa: version de scikit-learn distinta a la de entrenamiento.")
    print(f"  Version aqui: {SKLEARN_VER} — iguala a la de la laptop con:")
    print(f"     pip install scikit-learn==<version> --prefer-binary")
    sys.exit(1)
