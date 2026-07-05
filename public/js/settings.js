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

  const ruleFields = {
    product: ["imageFilename", "imageAlt", "seoTitle", "seoDescription", "tags", "newTags"],
    collection: ["imageFilename", "imageAlt", "seoTitle", "seoDescription"],
    article: ["imageFilename", "imageAlt", "seoTitle", "seoDescription", "tags", "newTags"],
  };

  let draftDescriptionPhrases = [];

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

  function buildSettingsPayload(overrides = {}) {
    return {
      shopify: {
        storeDomain: storeDomainInput.value.trim(),
        accessToken: overrides.accessToken ?? "",
      },
      rules: readRulesFromForm(),
      descriptionPhrases: overrides.descriptionPhrases ?? getDescriptionPhrases(),
      roomDetection: overrides.roomDetection ?? window.EditProSettings?.roomDetection,
    };
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
      roomDetection: data.roomDetection || {
        ollamaHost: "http://localhost:11434",
        ollamaModel: "gemma3:4b",
      },
      shopName: data.shopName || "",
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

  async function loadSettings() {
    try {
      const data = await EditProUtils.apiGet("/api/settings");
      applySettings(data);
      document.dispatchEvent(new CustomEvent("editpro:settings-loaded"));
    } catch (error) {
      EditProUtils.showMessage(connectionMessage, error.message, "error");
    }
  }

  async function saveConnection() {
    EditProUtils.hideMessage(connectionMessage);
    saveConnectionBtn.disabled = true;
    saveConnectionBtn.textContent = "Saving…";

    try {
      const data = await EditProUtils.apiPost("/api/settings", {
        ...buildSettingsPayload({ accessToken: accessTokenInput.value.trim() }),
      });
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
      const data = await EditProUtils.apiPost("/api/settings", buildSettingsPayload());
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
  descriptionPhrasesModalClose?.addEventListener("click", closeDescriptionPhrasesModal);
  cancelDescriptionPhrasesBtn?.addEventListener("click", closeDescriptionPhrasesModal);
  descriptionPhrasesModal?.querySelector(".modal-backdrop")?.addEventListener("click", closeDescriptionPhrasesModal);
  addDescriptionPhraseBtn?.addEventListener("click", addDescriptionPhrase);
  saveDescriptionPhrasesBtn?.addEventListener("click", saveDescriptionPhrases);
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
