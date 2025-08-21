document.addEventListener('DOMContentLoaded', () => {
    // STATE MANAGEMENT
    let appData = {
        missionTypes: {},
        subsystems: {},
        systems: {},
        planets: {},
        links: []
    };
    let selectedNodeId = null;

    // --- DOM ELEMENT CACHE ---
    const forms = {
        addType: document.getElementById('add-type-form'),
        addSubsystem: document.getElementById('add-subsystem-form'),
        addSystem: document.getElementById('add-system-form'),
        addPlanet: document.getElementById('add-planet-form'),
    };
    const inputs = {
        subsystemId: document.createElement('input'), // Hidden input for editing
        planetId: document.createElement('input'),    // Hidden input for editing
    };
    inputs.subsystemId.type = 'hidden';
    inputs.planetId.type = 'hidden';
    forms.addSubsystem.append(inputs.subsystemId);
    forms.addPlanet.append(inputs.planetId);

    const lists = {
        types: document.getElementById('types-list'),
        systems: document.getElementById('systems-list'),
    };
    const selects = {
        subsystemParent: document.getElementById('subsystem-parent-type'),
        planetParent: document.getElementById('planet-parent-system'),
    };
    const containers = {
        subsystemNodes: document.getElementById('subsystem-nodes'),
        planetNodes: document.getElementById('planet-nodes'),
        canvasContainer: document.querySelector('.canvas-container'),
    };
    const canvas = document.getElementById('linking-canvas');
    const buttons = {
        export: document.getElementById('export-btn'),
        import: document.getElementById('import-btn'),
    };
    const importFile = document.getElementById('import-file');

    // --- CORE FUNCTIONS ---

    function renderAll() {
        renderTypes();
        renderSystems();
        renderSubsystemNodes();
        renderPlanetNodes();
        updateCanvasSize(); // Ensure canvas is the right size
        renderLinks();
    }

    function generateId(prefix) {
        return `${prefix}-${crypto.randomUUID()}`;
    }

    // --- FORM & EDITING LOGIC ---
    function clearForms() {
        forms.addSubsystem.reset();
        forms.addPlanet.reset();
        inputs.subsystemId.value = '';
        inputs.planetId.value = '';
        selectedNodeId = null; // Clear the selected node ID

        const subBtn = forms.addSubsystem.querySelector('button');
        subBtn.textContent = 'Add Subsystem';
        subBtn.classList.remove('edit-mode');

        const planetBtn = forms.addPlanet.querySelector('button');
        planetBtn.textContent = 'Add Planet';
        planetBtn.classList.remove('edit-mode');

        renderLinks(); // Re-render links to remove highlights
    }


    function populateSubsystemForm(id) {
        // If clicking the same node again, clear forms and deselect it
        if (selectedNodeId === id) {
            clearForms();
            return;
        }

        clearForms();
        const sub = appData.subsystems[id];
        if (!sub) return;

        selectedNodeId = id; // Set the selected node
        inputs.subsystemId.value = id;
        selects.subsystemParent.value = sub.parentId;
        document.getElementById('subsystem-name').value = sub.name;
        document.getElementById('subsystem-desc').value = sub.description;
        document.getElementById('subsystem-time').value = sub.time;
        document.getElementById('subsystem-faction').value = sub.faction;
        document.getElementById('tag-legal').checked = sub.alignment.includes('legal');
        document.getElementById('tag-illegal').checked = sub.alignment.includes('illegal');

        const btn = forms.addSubsystem.querySelector('button');
        btn.textContent = 'Update Subsystem';
        btn.classList.add('edit-mode');

        renderLinks(); // Re-render links to apply highlights
    }

    // 2. REPLACE this function to add the deselect logic
    function populatePlanetForm(id) {
        // If clicking the same node again, clear forms and deselect it
        if (selectedNodeId === id) {
            clearForms();
            return;
        }

        clearForms();
        const planet = appData.planets[id];
        if (!planet) return;

        selectedNodeId = id; // Set the selected node
        inputs.planetId.value = id;
        selects.planetParent.value = planet.parentId;
        document.getElementById('planet-name').value = planet.name;

        const btn = forms.addPlanet.querySelector('button');
        btn.textContent = 'Update Planet';
        btn.classList.add('edit-mode');

        renderLinks(); // Re-render links to apply highlights
    }

    // 3. ADD this new function to dynamically resize the SVG canvas
    function updateCanvasSize() {
        // Ensure canvas is tall enough to encompass all nodes
        const subRect = containers.subsystemNodes.getBoundingClientRect();
        const plaRect = containers.planetNodes.getBoundingClientRect();
        const maxHeight = Math.max(subRect.height, plaRect.height) + 40; // Add padding
        canvas.style.height = `${maxHeight}px`;
    }

    // --- DATA DELETION ---
    function deleteItem(id, type) {
        if (!confirm(`Are you sure you want to delete this ${type.slice(0, -1)}?`)) return;

        delete appData[type][id];
        if (type === 'subsystems') appData.links = appData.links.filter(link => link.from !== id);
        if (type === 'planets') appData.links = appData.links.filter(link => link.to !== id);

        renderAll();
    }

    // --- RENDER FUNCTIONS ---

    function renderTypes() {
        lists.types.innerHTML = '';
        selects.subsystemParent.innerHTML = '<option value="" disabled selected>Select Mission Type</option>';
        Object.keys(appData.missionTypes).forEach(id => {
            const type = appData.missionTypes[id];
            const li = document.createElement('li');
            li.textContent = type.name;
            const delBtn = document.createElement('button');
            delBtn.textContent = 'X';
            delBtn.className = 'delete-btn';
            delBtn.onclick = () => deleteItem(id, 'missionTypes');
            li.appendChild(delBtn);
            lists.types.appendChild(li);

            const option = document.createElement('option');
            option.value = id;
            option.textContent = type.name;
            selects.subsystemParent.appendChild(option);
        });
    }

    function renderSystems() {
        lists.systems.innerHTML = '';
        selects.planetParent.innerHTML = '<option value="" disabled selected>Select System</option>';
        Object.keys(appData.systems).forEach(id => {
            const system = appData.systems[id];
            const li = document.createElement('li');
            li.textContent = system.name;
            const delBtn = document.createElement('button');
            delBtn.textContent = 'X';
            delBtn.className = 'delete-btn';
            delBtn.onclick = () => deleteItem(id, 'systems');
            li.appendChild(delBtn);
            lists.systems.appendChild(li);

            const option = document.createElement('option');
            option.value = id;
            option.textContent = system.name;
            selects.planetParent.appendChild(option);
        });
    }


    function renderSubsystemNodes() {
        containers.subsystemNodes.innerHTML = '';
        Object.keys(appData.subsystems).forEach(id => {
            const sub = appData.subsystems[id];
            const node = document.createElement('div');
            node.className = 'node subsystem-node';
            node.id = id;

            const isLegal = sub.alignment.includes('legal');
            const isIllegal = sub.alignment.includes('illegal');
            if (isLegal && isIllegal) node.classList.add('mixed-node');
            else if (isLegal) node.classList.add('legal-node');
            else if (isIllegal) node.classList.add('illegal-node');

            if (sub.disabled) node.classList.add('disabled');

            const header = document.createElement('div');
            header.className = 'node-header';

            const content = document.createElement('div');
            content.className = 'node-content';
            // UPDATED this line to include the mission type
            content.innerHTML = `<strong>${sub.name}</strong><span class="node-type">${appData.missionTypes[sub.parentId]?.name || ''}</span>`;
            content.onclick = () => populateSubsystemForm(id);

            const actions = document.createElement('div');
            actions.className = 'node-actions';
            const disableBtn = document.createElement('button');
            disableBtn.textContent = sub.disabled ? 'Enable' : 'Disable';
            disableBtn.onclick = () => {
                sub.disabled = !sub.disabled;
                renderSubsystemNodes();
            };
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Del';
            deleteBtn.className = 'delete-node-btn';
            deleteBtn.onclick = () => deleteItem(id, 'subsystems');

            actions.append(disableBtn, deleteBtn);
            header.append(content, actions);

            node.append(header);

            node.insertAdjacentHTML('beforeend', `<div class="node-handle handle-out"></div>`);
            containers.subsystemNodes.appendChild(node);
        });
    }

    function renderPlanetNodes() {
        containers.planetNodes.innerHTML = '';
        Object.keys(appData.planets).forEach(id => {
            const planet = appData.planets[id];
            const node = document.createElement('div');
            node.className = 'node planet-node';
            node.id = id;

            // --- START of New Logic ---
            // Calculate mission counts for this planet
            let legalCount = 0;
            let illegalCount = 0;

            appData.links
                .filter(link => link.to === id) // Find links connected to this planet
                .forEach(link => {
                    const sub = appData.subsystems[link.from];
                    if (sub && !sub.disabled) { // Only count enabled missions
                        if (sub.alignment.includes('legal')) legalCount++;
                        if (sub.alignment.includes('illegal')) illegalCount++;
                    }
                });

            const systemName = appData.systems[planet.parentId]?.name || '';
            // --- END of New Logic ---

            const header = document.createElement('div');
            header.className = 'node-header';

            const content = document.createElement('div');
            content.className = 'node-content';
            // UPDATED this line to include the system name and mission counts
            content.innerHTML = `
                <strong>${planet.name}</strong>
                <span class="node-system">${systemName}</span>
                <span class="node-mission-counts">${legalCount} Legal / ${illegalCount} Illegal</span>
            `;
            content.onclick = () => populatePlanetForm(id);

            const actions = document.createElement('div');
            actions.className = 'node-actions';
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Del';
            deleteBtn.className = 'delete-node-btn';
            deleteBtn.onclick = () => deleteItem(id, 'planets');

            actions.append(deleteBtn);
            header.append(content, actions);

            node.append(header);

            node.insertAdjacentHTML('beforeend', `<div class="node-handle handle-in"></div>`);
            containers.planetNodes.appendChild(node);
        });
    }

    // --- LINKING RENDER & LOGIC ---
    let isDrawing = false;
    let startNode = null;
    let tempLine = null;

    function getHandlePosition(node, handleType) {
        const parentContainer = node.parentElement; // e.g., #subsystem-nodes
        // Calculate position relative to the canvas by combining the parent's and the node's offsets
        const x = (handleType === 'out')
            ? parentContainer.offsetLeft + node.offsetLeft + node.offsetWidth - 2
            : parentContainer.offsetLeft + node.offsetLeft;
        const y = parentContainer.offsetTop + node.offsetTop + node.offsetHeight / 2;
        return { x, y };
    }

    function renderLinks() {
        const defs = canvas.querySelector('defs');
        canvas.innerHTML = '';
        if (defs) canvas.appendChild(defs);

        appData.links.forEach((link, index) => {
            const fromNode = document.getElementById(link.from);
            const toNode = document.getElementById(link.to);
            if (fromNode && toNode) {
                const startPos = getHandlePosition(fromNode, 'out');
                const endPos = getHandlePosition(toNode, 'in');
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('x1', startPos.x);
                line.setAttribute('y1', startPos.y);
                line.setAttribute('x2', endPos.x);
                line.setAttribute('y2', endPos.y);

                // Check if this link should be highlighted
                const isHighlighted = selectedNodeId && (link.from === selectedNodeId || link.to === selectedNodeId);

                line.setAttribute('stroke', isHighlighted ? 'var(--accent-blue)' : '#9a9a9a');
                line.setAttribute('stroke-width', isHighlighted ? '5' : '4');
                line.setAttribute('marker-end', 'url(#arrow)');

                line.addEventListener('click', () => {
                    if (confirm('Are you sure you want to delete this connection?')) {
                        appData.links.splice(index, 1);
                        renderLinks();
                    }
                });
                canvas.appendChild(line);
            }
        });
    }
    // --- EVENT LISTENERS ---

    // Form Submissions
    forms.addType.addEventListener('submit', (e) => { e.preventDefault(); appData.missionTypes[generateId('type')] = { name: e.target['type-name'].value }; e.target.reset(); renderTypes(); });
    forms.addSystem.addEventListener('submit', (e) => { e.preventDefault(); appData.systems[generateId('sys')] = { name: e.target['system-name'].value }; e.target.reset(); renderSystems(); });
    forms.addSubsystem.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = inputs.subsystemId.value || generateId('sub');
        const alignment = [];
        if (e.target['tag-legal'].checked) alignment.push('legal');
        if (e.target['tag-illegal'].checked) alignment.push('illegal');

        appData.subsystems[id] = {
            parentId: e.target['subsystem-parent-type'].value,
            name: e.target['subsystem-name'].value,
            description: e.target['subsystem-desc'].value,
            time: parseInt(e.target['subsystem-time'].value),
            faction: e.target['subsystem-faction'].value,
            alignment: alignment,
            disabled: appData.subsystems[id]?.disabled || false
        };
        clearForms();
        renderSubsystemNodes();
    });
    forms.addPlanet.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = inputs.planetId.value || generateId('pla');
        appData.planets[id] = {
            parentId: e.target['planet-parent-system'].value,
            name: e.target['planet-name'].value
        };
        clearForms();
        renderPlanetNodes();
    });

    // Drawing Logic
    document.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('handle-out')) {
            isDrawing = true;
            startNode = e.target.parentElement;
            const startPos = getHandlePosition(startNode, 'out');
            tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            tempLine.setAttribute('x1', startPos.x); tempLine.setAttribute('y1', startPos.y);
            tempLine.setAttribute('x2', startPos.x); tempLine.setAttribute('y2', startPos.y);
            tempLine.setAttribute('stroke', 'var(--accent-blue)'); tempLine.setAttribute('stroke-width', '2');
            canvas.appendChild(tempLine);
        }
    });
    document.addEventListener('mousemove', (e) => {
        if (isDrawing) {
            const canvasRect = containers.canvasContainer.getBoundingClientRect();
            tempLine.setAttribute('x2', e.clientX - canvasRect.left);
            tempLine.setAttribute('y2', e.clientY - canvasRect.top);
        }
    });
    document.addEventListener('mouseup', (e) => {
        if (isDrawing) {
            if (e.target.classList.contains('handle-in')) {
                const endNode = e.target.parentElement;
                const linkExists = appData.links.some(link => link.from === startNode.id && link.to === endNode.id);
                if (!linkExists) appData.links.push({ from: startNode.id, to: endNode.id });
            }
            tempLine.remove();
            isDrawing = false;
            startNode = null;
            tempLine = null;
            renderLinks();
        }
    });

    // Deselect / Clear forms when clicking background
    const adminContainer = document.querySelector('.admin-container');
    adminContainer.addEventListener('mousedown', (e) => {
        // List of valid targets for a "click away"
        const clickAwayTargets = [
            'admin-container',
            'definitions-panel',
            'locations-panel',
            'canvas-container'
        ];

        // Check if the clicked element's ID or class is in our list
        const targetId = e.target.id;
        const targetClass = e.target.className;

        if (clickAwayTargets.includes(targetId) || clickAwayTargets.includes(targetClass)) {
            clearForms();
        }
    });

    // Import/Export
    buttons.export.addEventListener('click', () => {
        const dataStr = JSON.stringify(appData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'missions.json';
        a.click();
        URL.revokeObjectURL(url);
    });
    buttons.import.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const importedData = JSON.parse(event.target.result);
                if (importedData.missionTypes && importedData.subsystems) {
                    appData = importedData;
                    renderAll();
                } else {
                    alert('Invalid JSON file format.');
                }
            } catch (error) {
                alert('Error parsing JSON file.'); console.error(error);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // Initial Render
    renderAll();
});