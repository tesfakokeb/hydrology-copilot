"""LSTM and GRU forecasters.

Imported only when PyTorch is installed. The class exposes the scikit-learn
`fit`/`predict` surface so the forecasting pipeline treats it identically to
the tree-based models — same chronological split, same validation, same
residual ensemble.

The network is deliberately small. On a single-catchment daily record of a few
thousand samples, a large recurrent model overfits long before it out-performs
gradient boosting; the value of having it here is the ability to compare
architectures honestly on the same split, not to win the comparison.
"""

from __future__ import annotations

import numpy as np


class RecurrentForecaster:
    def __init__(self, kind: str = "lstm", seed: int = 20260901, hidden: int = 48, layers: int = 1,
                 epochs: int = 120, lr: float = 5e-3, patience: int = 15) -> None:
        import torch  # noqa: F401  (import here so the module is optional)

        self.kind = kind
        self.seed = seed
        self.hyperparameters = {
            "architecture": kind.upper(),
            "hidden_units": hidden,
            "layers": layers,
            "epochs": epochs,
            "learning_rate": lr,
            "early_stopping_patience": patience,
            "loss": "mse",
            "optimiser": "adam",
        }
        self._model = None
        self._mu = None
        self._sd = None

    def fit(self, X: np.ndarray, y: np.ndarray) -> "RecurrentForecaster":
        import torch
        import torch.nn as nn

        torch.manual_seed(self.seed)
        np.random.seed(self.seed)

        self._mu = X.mean(axis=0)
        self._sd = X.std(axis=0)
        self._sd[self._sd == 0] = 1.0
        Xs = (X - self._mu) / self._sd

        # The feature vector already encodes the lag structure, so each sample
        # is presented as a length-1 sequence of features. This keeps the
        # comparison with the tree models like-for-like on identical inputs.
        xt = torch.tensor(Xs, dtype=torch.float32).unsqueeze(1)
        yt = torch.tensor(y, dtype=torch.float32).unsqueeze(1)

        hidden = int(self.hyperparameters["hidden_units"])
        layers = int(self.hyperparameters["layers"])
        rnn_cls = nn.LSTM if self.kind == "lstm" else nn.GRU

        class Net(nn.Module):
            def __init__(self, n_features: int) -> None:
                super().__init__()
                self.rnn = rnn_cls(n_features, hidden, layers, batch_first=True)
                self.head = nn.Sequential(nn.Linear(hidden, 32), nn.ReLU(), nn.Linear(32, 1))

            def forward(self, x):
                out, _ = self.rnn(x)
                return self.head(out[:, -1, :])

        model = Net(X.shape[1])
        opt = torch.optim.Adam(model.parameters(), lr=float(self.hyperparameters["learning_rate"]))
        loss_fn = nn.MSELoss()

        # Hold out the last 15 % of the training block for early stopping, so
        # the epoch count is chosen without touching the validation period.
        cut = int(len(xt) * 0.85)
        best, best_state, bad = float("inf"), None, 0
        for _ in range(int(self.hyperparameters["epochs"])):
            model.train()
            opt.zero_grad()
            loss = loss_fn(model(xt[:cut]), yt[:cut])
            loss.backward()
            opt.step()

            model.eval()
            with torch.no_grad():
                val = float(loss_fn(model(xt[cut:]), yt[cut:]))
            if val < best - 1e-5:
                best, bad = val, 0
                best_state = {k: v.clone() for k, v in model.state_dict().items()}
            else:
                bad += 1
                if bad >= int(self.hyperparameters["early_stopping_patience"]):
                    break

        if best_state is not None:
            model.load_state_dict(best_state)
        model.eval()
        self._model = model
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        import torch

        if self._model is None:
            raise RuntimeError("The model has not been fitted.")
        Xs = (X - self._mu) / self._sd
        with torch.no_grad():
            out = self._model(torch.tensor(Xs, dtype=torch.float32).unsqueeze(1))
        return out.numpy().ravel()
