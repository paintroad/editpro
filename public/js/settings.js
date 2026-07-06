(function initSettingsModule() {
  const storeDomainInput = document.getElementById("storeDomain");
  const accessTokenInput = document.getElementById("accessToken");
  const tokenHint = document.getElementById("tokenHint");
  const saveConnectionBtn = document.getElementById("saveConnectionBtn");
  const saveRulesBtn = document.getElementById("saveRulesBtn");
  const testConnectionBtn = document.getElementById("testConnectionBtn");
  const connectionMessage = document.getElementById("connectionMessage");
  const rulesMessage = document.getElementById("rulesMessage");
  const configPathHint = document.getElementById("configPathHint");

  const descriptionPhrasesModal = document.getElementById("descriptionPhrasesModal");
  const descriptionPhrasesModalClose = document.getElementById("descriptionPhrasesModalClose");
  const descriptionPhrasesList = document.getElementById("descriptionPhrasesList");
  const newDescriptionPhraseInput = document.getElementById("newDescriptionPhraseInput");
  const addDescriptionPhraseBtn = document.getElementById("addDescriptionPhraseBtn");
  const saveDescriptionPhrasesBtn = document.getElementById("saveDescriptionPhrasesBtn");
  const cancelDescriptionPhrasesBtn = document.getElementById("cancelDescriptionPhrasesBtn");
  const descriptionPhrasesMessage = document.getElementById("descriptionPhrasesMessage");

  const roomFallbacksModal = document.getElementById("roomFallbacksModal");
  const roomFallbacksModalClose = document.getElementById("roomFallbacksModalClose");
  const roomFallbacksList = document.getElementById("roomFallbacksList");
  const newRoomFallbackInput = document.getElementById("newRoomFallbackInput");
  const addRoomFallbackBtn = document.getElementById("addRoomFallbackBtn");
  const saveRoomFallbacksBtn = document.getElementById("saveRoomFallbacksBtn");
  const cancelRoomFallbacksBtn = document.getElementById("cancelRoomFallbacksBtn");
  const roomFallbacksMessage = document.getElementById("roomFallbacksMessage");

  const MIN_ROOM_FALLBACKS = 20;

  const ruleFields = {
    product: ["imageFilename", "imageAlt", "seoTitle", "seoDescription", "tags", "newTags"],
    collection: ["imageFilename", "imageAlt", "seoTitle", "seoDescription"],
    article: ["imageFilename", "imageAlt", "seoTitle", "seoDescription", "tags", "newTags"],
  };

  let draftDescriptionPhrases = [];
  let draftRoomFallbacks = [];

  function readRulesFromForm() {
    const rules = { product: {}, collection: {}, article: {} };
    for (const [type, fields] of Object.entries(ruleFields)) {
      for (const field of fields) {
        const el = document.getElementById(`rule-${type}-${field}`);
        if (el) {
          rules[type][field] = el.value;
        }
      }
    }
    return rules;
  }

  function getDescriptionPhrases() {
    return window.EditProSettings?.descriptionPhrases || [];
  }

  function getRoomFallbacks() {
    return window.EditProSettings?.roomFallbacks || [];
  }

  function buildSettingsPayload(overrides = {}) {
    const payload = {
      shopify: {
        storeDomain: storeDomainInput.value.trim(),
        accessToken: overrides.accessToken ?? "",
      },
      rules: readRulesFromForm(),
      descriptionPhrases: overrides.descriptionPhrases ?? getDescriptionPhrases(),
      roomFallbacks: overrides.roomFallbacks ?? getRoomFallbacks(),
    };
    if (Object.prototype.hasOwnProperty.call(overrides, "roomDetection")) {
      payload.roomDetection = overrides.roomDetection;
    }
    return payload;
  }

  function fillRulesForm(rules) {
    for (const [type, fields] of Object.entries(ruleFields)) {
      for (const field of fields) {
        const el = document.getElementById(`rule-${type}-${field}`);
        if (el && rules?.[type]?.[field] != null) {
          el.value = rules[type][field];
        }
      }
    }
  }

  function applySettings(data) {
    storeDomainInput.value = data.shopify.storeDomain || "";
    tokenHint.textContent = data.shopify.hasToken
      ? `Saved token: ${data.shopify.accessTokenMasked}`
      : "No token saved yet.";
    configPathHint.textContent = data.configPath
      ? `Credentials stored locally at ${data.configPath}`
      : "";
    fillRulesForm(data.rules);
    window.EditProSettings = {
      rules: data.rules,
      descriptionPhrases: Array.isArray(data.descriptionPhrases) ? data.descriptionPhrases : [],
      roomFallbacks: Array.isArray(data.roomFallbacks) ? data.roomFallbacks : [],
      roomDetection: data.roomDetection || {
        openaiModel: "gpt-4o",
        openaiDetail: "low",
        openaiConcurrency: 8,
      },
      shopName: data.shopName || "",
      defaultCatalogPath: data.defaultCatalogPath || EditProUtils.getDefaultCatalogPath(),
      defaultCatalogBuilderPath:
        data.defaultCatalogBuilderPath || EditProUtils.getDefaultCatalogBuilderPath(),
      storeDomain: data.shopify.storeDomain || "",
      connected: Boolean(data.shopify.hasToken && data.shopify.storeDomain),
    };
  }

  function renderDescriptionPhrasesList() {
    if (!descriptionPhrasesList) {
      return;
    }
    if (!draftDescriptionPhrases.length) {
      descriptionPhrasesList.innerHTML = '<p class="meta phrases-empty">No phrases yet. Add one above.</p>';
      return;
    }
    descriptionPhrasesList.innerHTML = draftDescriptionPhrases
      .map(
        (phrase, index) => `
          <div class="phrases-list-item" role="listitem">
            <span class="phrases-list-index">${index + 1}.</span>
            <span class="phrases-list-text">${EditProUtils.escapeHtml(phrase)}</span>
            <button type="button" class="phrases-delete-btn" data-phrase-index="${index}" aria-label="Delete phrase">&times;</button>
          </div>`
      )
      .join("");
  }

  function openDescriptionPhrasesModal() {
    draftDescriptionPhrases = [...getDescriptionPhrases()];
    renderDescriptionPhrasesList();
    EditProUtils.hideMessage(descriptionPhrasesMessage);
    if (newDescriptionPhraseInput) {
      newDescriptionPhraseInput.value = "";
    }
    descriptionPhrasesModal.hidden = false;
  }

  function closeDescriptionPhrasesModal() {
    descriptionPhrasesModal.hidden = true;
    draftDescriptionPhrases = [];
    EditProUtils.hideMessage(descriptionPhrasesMessage);
  }

  function addDescriptionPhrase() {
    const phrase = newDescriptionPhraseInput?.value.trim();
    if (!phrase) {
      return;
    }
    const exists = draftDescriptionPhrases.some(
      (item) => item.toLowerCase() === phrase.toLowerCase()
    );
    if (exists) {
      EditProUtils.showMessage(descriptionPhrasesMessage, "That phrase is already in the list.", "warning");
      return;
    }
    draftDescriptionPhrases.push(phrase);
    if (newDescriptionPhraseInput) {
      newDescriptionPhraseInput.value = "";
    }
    EditProUtils.hideMessage(descriptionPhrasesMessage);
    renderDescriptionPhrasesList();
  }

  function deleteDescriptionPhrase(index) {
    if (index < 0 || index >= draftDescriptionPhrases.length) {
      return;
    }
    draftDescriptionPhrases.splice(index, 1);
    renderDescriptionPhrasesList();
  }

  async function saveDescriptionPhrases() {
    EditProUtils.hideMessage(descriptionPhrasesMessage);
    saveDescriptionPhrasesBtn.disabled = true;
    saveDescriptionPhrasesBtn.textContent = "Saving…";

    try {
      const data = await EditProUtils.apiPost("/api/settings", {
        ...buildSettingsPayload({ descriptionPhrases: draftDescriptionPhrases }),
      });
      applySettings(data);
      document.dispatchEvent(new CustomEvent("editpro:settings-saved"));
      EditProUtils.showMessage(descriptionPhrasesMessage, "Phrases saved.", "success");
      setTimeout(closeDescriptionPhrasesModal, 400);
    } catch (error) {
      EditProUtils.showMessage(descriptionPhrasesMessage, error.message, "error");
    } finally {
      saveDescriptionPhrasesBtn.disabled = false;
      saveDescriptionPhrasesBtn.textContent = "Save phrases";
    }
  }

  function renderRoomFallbacksList() {
    if (!roomFallbacksList) {
      return;
    }
    if (!draftRoomFallbacks.length) {
      roomFallbacksList.innerHTML = '<p class="meta phrases-empty">No fallbacks yet. Add one above.</p>';
      return;
    }
    roomFallbacksList.innerHTML = draftRoomFallbacks
      .map(
        (item, index) => `
          <div class="phrases-list-item" role="listitem">
            <span class="phrases-list-index">${index + 1}.</span>
            <span class="phrases-list-text">${EditProUtils.escapeHtml(item)}</span>
            <button type="button" class="phrases-delete-btn" data-fallback-index="${index}" aria-label="Delete fallback">&times;</button>
          </div>`
      )
      .join("");
  }

  function openRoomFallbacksModal() {
    draftRoomFallbacks = [...getRoomFallbacks()];
    renderRoomFallbacksList();
    EditProUtils.hideMessage(roomFallbacksMessage);
    if (newRoomFallbackInput) {
      newRoomFallbackInput.value = "";
    }
    roomFallbacksModal.hidden = false;
  }

  function closeRoomFallbacksModal() {
    roomFallbacksModal.hidden = true;
    draftRoomFallbacks = [];
    EditProUtils.hideMessage(roomFallbacksMessage);
  }

  function addRoomFallback() {
    const item = newRoomFallbackInput?.value.trim();
    if (!item) {
      return;
    }
    const exists = draftRoomFallbacks.some(
      (entry) => entry.toLowerCase() === item.toLowerCase()
    );
    if (exists) {
      EditProUtils.showMessage(roomFallbacksMessage, "That option is already in the list.", "warning");
      return;
    }
    draftRoomFallbacks.push(item);
    if (newRoomFallbackInput) {
      newRoomFallbackInput.value = "";
    }
    EditProUtils.hideMessage(roomFallbacksMessage);
    renderRoomFallbacksList();
  }

  function deleteRoomFallback(index) {
    if (index < 0 || index >= draftRoomFallbacks.length) {
      return;
    }
    draftRoomFallbacks.splice(index, 1);
    renderRoomFallbacksList();
  }

  async function saveRoomFallbacks() {
    EditProUtils.hideMessage(roomFallbacksMessage);
    if (draftRoomFallbacks.length < MIN_ROOM_FALLBACKS) {
      EditProUtils.showMessage(
        roomFallbacksMessage,
        `Keep at least ${MIN_ROOM_FALLBACKS} unique options so image renames can avoid collisions.`,
        "warning"
      );
      return;
    }
    saveRoomFallbacksBtn.disabled = true;
    saveRoomFallbacksBtn.textContent = "Saving…";

    try {
      const data = await EditProUtils.apiPost("/api/settings", {
        ...buildSettingsPayload({ roomFallbacks: draftRoomFallbacks }),
      });
      applySettings(data);
      document.dispatchEvent(new CustomEvent("editpro:settings-saved"));
      EditProUtils.showMessage(roomFallbacksMessage, "Fallbacks saved.", "success");
      setTimeout(closeRoomFallbacksModal, 400);
    } catch (error) {
      EditProUtils.showMessage(roomFallbacksMessage, error.message, "error");
    } finally {
      saveRoomFallbacksBtn.disabled = false;
      saveRoomFallbacksBtn.textContent = "Save fallbacks";
    }
  }

  async function loadSettings() {
    try {
      const data = await EditProUtils.apiGet("/api/settings");
      applySettings(data);
      document.dispatchEvent(new CustomEvent("editpro:settings-loaded"));
      if (data.shopify?.hasToken && data.shopify?.storeDomain) {
        try {
          const result = await EditProShopify.testConnection();
          if (result.shop?.name) {
            window.EditProSettings.shopName = result.shop.name;
            document.dispatchEvent(
              new CustomEvent("editpro:shop-name-updated", {
                detail: { shopName: result.shop.name },
              })
            );
          }
        } catch {
          // keep cached shop name
        }
      }
    } catch (error) {
      EditProUtils.showMessage(connectionMessage, error.message, "error");
    }
  }

  async function saveConnection() {
    EditProUtils.hideMessage(connectionMessage);
    saveConnectionBtn.disabled = true;
    saveConnectionBtn.textContent = "Saving…";

    try {
      const payload = buildSettingsPayload({ accessToken: accessTokenInput.value.trim() });
      const data = await EditProUtils.apiPost("/api/settings", payload);
      accessTokenInput.value = "";
      applySettings(data);
      document.dispatchEvent(new CustomEvent("editpro:settings-saved"));
      EditProUtils.showMessage(connectionMessage, "Connection saved.", "success");
    } catch (error) {
      EditProUtils.showMessage(connectionMessage, error.message, "error");
    } finally {
      saveConnectionBtn.disabled = false;
      saveConnectionBtn.textContent = "Save connection";
    }
  }

  async function saveRules() {
    EditProUtils.hideMessage(rulesMessage);
    saveRulesBtn.disabled = true;
    saveRulesBtn.textContent = "Saving…";

    try {
      const payload = buildSettingsPayload();
      const data = await EditProUtils.apiPost("/api/settings", payload);
      applySettings(data);
      document.dispatchEvent(new CustomEvent("editpro:settings-saved"));
      EditProUtils.showMessage(rulesMessage, "Rules saved.", "success");
    } catch (error) {
      EditProUtils.showMessage(rulesMessage, error.message, "error");
    } finally {
      saveRulesBtn.disabled = false;
      saveRulesBtn.textContent = "Save rules";
    }
  }

  async function testConnection() {
    EditProUtils.hideMessage(connectionMessage);
    testConnectionBtn.disabled = true;
    testConnectionBtn.textContent = "Testing…";

    try {
      if (accessTokenInput.value.trim() || storeDomainInput.value.trim()) {
        await EditProUtils.apiPost("/api/settings", {
          ...buildSettingsPayload({ accessToken: accessTokenInput.value.trim() }),
        });
      }
      const result = await EditProShopify.testConnection();
      window.EditProSettings = window.EditProSettings || {};
      window.EditProSettings.shopName = result.shop?.name || "";
      window.EditProSettings.storeDomain = result.shop?.myshopifyDomain || storeDomainInput.value.trim();
      window.EditProSettings.connected = true;

      let message = `Connected to ${result.shop.name} (${result.shop.myshopifyDomain}).`;
      let type = "success";
      try {
        await EditProShopify.graphql(
          `query ContentAccessCheck { articles(first: 1) { nodes { id } } }`
        );
        window.EditProSettings.contentAccess = true;
      } catch (error) {
        if (EditProUtils.isAccessDeniedError(error.message)) {
          window.EditProSettings.contentAccess = false;
          message +=
            " Blog articles need read_content and write_content scopes. Products and collections will still work.";
          type = "warning";
        }
      }

      document.dispatchEvent(new CustomEvent("editpro:settings-saved"));
      EditProUtils.showMessage(connectionMessage, message, type);
    } catch (error) {
      EditProUtils.showMessage(connectionMessage, error.message, "error");
    } finally {
      testConnectionBtn.disabled = false;
      testConnectionBtn.textContent = "Test connection";
    }
  }

  saveConnectionBtn?.addEventListener("click", saveConnection);
  saveRulesBtn?.addEventListener("click", saveRules);
  testConnectionBtn?.addEventListener("click", testConnection);

  document.querySelectorAll(".manage-phrases-btn").forEach((btn) => {
    btn.addEventListener("click", openDescriptionPhrasesModal);
  });
  document.querySelectorAll(".manage-room-fallbacks-btn").forEach((btn) => {
    btn.addEventListener("click", openRoomFallbacksModal);
  });
  descriptionPhrasesModalClose?.addEventListener("click", closeDescriptionPhrasesModal);
  cancelDescriptionPhrasesBtn?.addEventListener("click", closeDescriptionPhrasesModal);
  descriptionPhrasesModal?.querySelector(".modal-backdrop")?.addEventListener("click", closeDescriptionPhrasesModal);
  addDescriptionPhraseBtn?.addEventListener("click", addDescriptionPhrase);
  saveDescriptionPhrasesBtn?.addEventListener("click", saveDescriptionPhrases);
  roomFallbacksModalClose?.addEventListener("click", closeRoomFallbacksModal);
  cancelRoomFallbacksBtn?.addEventListener("click", closeRoomFallbacksModal);
  roomFallbacksModal?.querySelector(".modal-backdrop")?.addEventListener("click", closeRoomFallbacksModal);
  addRoomFallbackBtn?.addEventListener("click", addRoomFallback);
  saveRoomFallbacksBtn?.addEventListener("click", saveRoomFallbacks);
  newRoomFallbackInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addRoomFallback();
    }
  });
  roomFallbacksList?.addEventListener("click", (event) => {
    const btn = event.target.closest(".phrases-delete-btn");
    if (!btn) {
      return;
    }
    deleteRoomFallback(Number(btn.dataset.fallbackIndex));
  });
  newDescriptionPhraseInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addDescriptionPhrase();
    }
  });
  descriptionPhrasesList?.addEventListener("click", (event) => {
    const btn = event.target.closest(".phrases-delete-btn");
    if (!btn) {
      return;
    }
    deleteDescriptionPhrase(Number(btn.dataset.phraseIndex));
  });

  loadSettings();
})();
