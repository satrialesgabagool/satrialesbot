"""Probability models for predicting binary market outcomes."""

from abc import ABC, abstractmethod
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
import xgboost as xgb


class ProbabilityModel(ABC):
    """Base class for all probability models."""

    @abstractmethod
    def fit(self, X: pd.DataFrame, y: pd.Series) -> None:
        ...

    @abstractmethod
    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        """Return array of P(outcome=1) for each sample."""
        ...

    @abstractmethod
    def get_params(self) -> dict:
        ...


class BlackScholesBaseline(ProbabilityModel):
    """
    Non-ML baseline: uses the bs_implied_prob feature directly.
    If ML models can't beat this, there is no learnable edge.
    """

    def fit(self, X: pd.DataFrame, y: pd.Series) -> None:
        pass  # no-op

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        if "bs_implied_prob" in X.columns:
            return X["bs_implied_prob"].values.astype(float)
        return np.full(len(X), 0.5)

    def get_params(self) -> dict:
        return {"model": "black_scholes_baseline"}


class LogisticModel(ProbabilityModel):
    """
    Logistic regression with L2 regularization + feature scaling.
    Well-calibrated probabilities, interpretable, good baseline.
    """

    def __init__(self, C: float = 1.0):
        self.C = C
        self.pipeline = Pipeline([
            ("scaler", StandardScaler()),
            ("clf", LogisticRegression(C=C, max_iter=1000, solver="lbfgs")),
        ])
        self._fitted = False

    def fit(self, X: pd.DataFrame, y: pd.Series) -> None:
        self.pipeline.fit(X, y)
        self._fitted = True

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        if not self._fitted:
            return np.full(len(X), 0.5)
        proba = self.pipeline.predict_proba(X)
        # Column 1 = P(outcome=1)
        return proba[:, 1] if proba.shape[1] > 1 else proba[:, 0]

    def get_params(self) -> dict:
        return {"model": "logistic", "C": self.C}


class GradientBoostingModel(ProbabilityModel):
    """
    XGBoost binary classifier. Captures nonlinear feature interactions.
    """

    def __init__(self, n_estimators: int = 100, max_depth: int = 3,
                 learning_rate: float = 0.1, subsample: float = 0.8,
                 colsample_bytree: float = 0.8, min_child_weight: int = 5):
        self.params = {
            "n_estimators": n_estimators,
            "max_depth": max_depth,
            "learning_rate": learning_rate,
            "subsample": subsample,
            "colsample_bytree": colsample_bytree,
            "min_child_weight": min_child_weight,
        }
        self.model = xgb.XGBClassifier(
            **self.params,
            objective="binary:logistic",
            eval_metric="logloss",
            verbosity=0,
        )
        self._fitted = False

    def fit(self, X: pd.DataFrame, y: pd.Series) -> None:
        self.model.fit(X, y)
        self._fitted = True

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        if not self._fitted:
            return np.full(len(X), 0.5)
        proba = self.model.predict_proba(X)
        return proba[:, 1] if proba.shape[1] > 1 else proba[:, 0]

    def get_params(self) -> dict:
        return {"model": "xgboost", **self.params}


class EnsembleModel(ProbabilityModel):
    """
    Weighted average of LogisticModel and GradientBoostingModel.
    Reduces variance, tends to be better calibrated than either alone.
    """

    def __init__(self, gbm_weight: float = 0.6, lr_C: float = 1.0,
                 gbm_n_estimators: int = 100, gbm_max_depth: int = 3,
                 gbm_learning_rate: float = 0.1, gbm_subsample: float = 0.8,
                 gbm_colsample: float = 0.8, gbm_min_child_weight: int = 5):
        self.gbm_weight = gbm_weight
        self.lr = LogisticModel(C=lr_C)
        self.gbm = GradientBoostingModel(
            n_estimators=gbm_n_estimators,
            max_depth=gbm_max_depth,
            learning_rate=gbm_learning_rate,
            subsample=gbm_subsample,
            colsample_bytree=gbm_colsample,
            min_child_weight=gbm_min_child_weight,
        )

    def fit(self, X: pd.DataFrame, y: pd.Series) -> None:
        self.lr.fit(X, y)
        self.gbm.fit(X, y)

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        lr_prob = self.lr.predict_proba(X)
        gbm_prob = self.gbm.predict_proba(X)
        return self.gbm_weight * gbm_prob + (1 - self.gbm_weight) * lr_prob

    def get_params(self) -> dict:
        return {
            "model": "ensemble",
            "gbm_weight": self.gbm_weight,
            **{f"lr_{k}": v for k, v in self.lr.get_params().items()},
            **{f"gbm_{k}": v for k, v in self.gbm.get_params().items()},
        }


class MomentumModel(ProbabilityModel):
    """
    Adjusts Black-Scholes probability by BTC momentum signal.
    Non-ML: uses logistic adjustment based on recent BTC returns.
    """

    def __init__(self, momentum_weight: float = 1.0, vol_adjustment: float = 0.5):
        self.momentum_weight = momentum_weight
        self.vol_adjustment = vol_adjustment

    def fit(self, X: pd.DataFrame, y: pd.Series) -> None:
        # Simple grid search for optimal momentum_weight on training data
        best_weight = self.momentum_weight
        best_score = -1.0

        for w in np.arange(0.2, 3.0, 0.2):
            self.momentum_weight = w
            preds = self.predict_proba(X)
            # Brier score (lower is better)
            brier = np.mean((preds - y.values) ** 2)
            if best_score < 0 or brier < best_score:
                best_score = brier
                best_weight = w

        self.momentum_weight = best_weight

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        bs_prob = X["bs_implied_prob"].values if "bs_implied_prob" in X.columns else np.full(len(X), 0.5)
        momentum = X["btc_return_in_window"].values if "btc_return_in_window" in X.columns else np.zeros(len(X))
        vol = X["btc_realized_vol_5m"].values if "btc_realized_vol_5m" in X.columns else np.ones(len(X)) * 0.001

        # Convert BS prob to logit, adjust by momentum, convert back
        logit_bs = np.log(np.clip(bs_prob, 0.01, 0.99) / (1 - np.clip(bs_prob, 0.01, 0.99)))
        adjustment = self.momentum_weight * momentum / (vol + 1e-10)
        adjustment = np.clip(adjustment, -3.0, 3.0)
        adjusted_logit = logit_bs + adjustment

        return 1.0 / (1.0 + np.exp(-adjusted_logit))

    def get_params(self) -> dict:
        return {"model": "momentum", "momentum_weight": self.momentum_weight,
                "vol_adjustment": self.vol_adjustment}


class MeanReversionModel(ProbabilityModel):
    """
    Bets against recent market price extremes relative to BS fair value.
    """

    def __init__(self, alpha: float = 0.5):
        self.alpha = alpha

    def fit(self, X: pd.DataFrame, y: pd.Series) -> None:
        best_alpha = self.alpha
        best_score = -1.0

        for a in np.arange(0.1, 0.9, 0.05):
            self.alpha = a
            preds = self.predict_proba(X)
            brier = np.mean((preds - y.values) ** 2)
            if best_score < 0 or brier < best_score:
                best_score = brier
                best_alpha = a

        self.alpha = best_alpha

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        bs_prob = X["bs_implied_prob"].values if "bs_implied_prob" in X.columns else np.full(len(X), 0.5)
        mkt_prob = X["market_price_latest"].values if "market_price_latest" in X.columns else np.full(len(X), 0.5)

        # Model believes truth is closer to BS than market: pull market toward BS
        model_prob = mkt_prob + self.alpha * (bs_prob - mkt_prob)
        return np.clip(model_prob, 0.01, 0.99)

    def get_params(self) -> dict:
        return {"model": "mean_reversion", "alpha": self.alpha}
