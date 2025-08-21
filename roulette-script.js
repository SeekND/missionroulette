document.addEventListener('DOMContentLoaded', () => {
    // --- STATE & DATA ---
    let missionData = {};
    const userChoices = {
        duration: 60,
        alignment: 'any',
        type: 'any',
        system: 'any',
        crewSize: 1 // MODIFICATION #3
    };
    // MODIFICATIONS #5 & #6: New travel time constants
    const TRAVEL_TIME_STANTON = 5;
    const TRAVEL_TIME_PYRO = 7;
    const TRAVEL_TIME_CROSS_SYSTEM = 9;

    // --- DOM ELEMENTS ---
    const views = document.querySelectorAll('.view');
    const durationSlider = document.getElementById('session-duration');
    const durationDisplay = document.getElementById('duration-display');
    const alignmentButtons = document.querySelectorAll('.choice-btn');
    const backButtons = document.querySelectorAll('.back-btn');

    // --- INITIALIZATION ---
    async function initialize() {
        try {
            const response = await fetch('missions.json');
            if (!response.ok) throw new Error('Network response was not ok');
            missionData = await response.json();
            setupEventListeners();
            populateFilters();
        } catch (error) {
            console.error('Failed to load mission data:', error);
            alert('Error: Could not load mission data. Please check missions.json and refresh.');
        }
    }

    // --- VIEW MANAGEMENT ---
    function showView(viewId) {
        views.forEach(view => {
            view.classList.toggle('active', view.id === viewId);
        });
    }

    // --- EVENT LISTENERS ---
    function setupEventListeners() {
        // --- START of Changes ---
        // Get a direct reference to the button here
        const copyBtn = document.getElementById('btn-copy-discord');
        // --- END of Changes ---

    durationSlider.addEventListener('input', (e) => {
        const totalMinutes = parseInt(e.target.value);
        userChoices.duration = totalMinutes;

        if (totalMinutes < 60) {
            durationDisplay.textContent = `${totalMinutes} minutes`;
        } else {
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            const hourText = hours > 1 ? 'hours' : 'hour';
            const minuteText = minutes > 0 ? ` ${minutes} minutes` : '';
            durationDisplay.textContent = `${hours} ${hourText}${minuteText}`;
        }
    });

        alignmentButtons.forEach(button => {
            button.addEventListener('click', () => {
                userChoices.alignment = button.dataset.alignment;
                document.body.className = `theme-${userChoices.alignment}`;
                document.getElementById('path-summary').textContent =
                    `${userChoices.duration} minute, ${userChoices.alignment}`;
                showView('view-path');
            });
        });

        backButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const targetView = e.currentTarget.dataset.target;
                if (targetView === 'view-setup') {
                    document.body.className = '';
                }
                showView(targetView);
            });
        });

        document.getElementById('btn-quick-session').addEventListener('click', () => {
            userChoices.type = 'any';
            userChoices.system = 'any';
            userChoices.crewSize = 1;
            generateAndDisplayPlaylist();
        });

        document.getElementById('btn-custom-session').addEventListener('click', () => showView('view-filters'));

        document.getElementById('btn-generate').addEventListener('click', () => {
            userChoices.type = document.getElementById('filter-type').value;
            userChoices.system = document.getElementById('filter-system').value;
            userChoices.crewSize = document.getElementById('filter-crew').value;
            generateAndDisplayPlaylist();
        });

        // --- START of Changes ---
        // Use the direct reference in the event listener
        copyBtn.addEventListener('click', () => {
            const playlistText = copyBtn.dataset.playlistText;
            if (playlistText) {
                navigator.clipboard.writeText(playlistText).then(() => {
                    copyBtn.textContent = '✅ Copied!';
                    setTimeout(() => {
                        copyBtn.textContent = '📋 Copy to Clipboard!';
                    }, 2000);
                });
            }
        });
        // --- END of Changes ---
    }

    // --- CORE LOGIC ---
    function populateFilters() {
        const typeSelect = document.getElementById('filter-type');
        Object.values(missionData.missionTypes).forEach(type => {
            const option = new Option(type.name, type.name);
            typeSelect.add(option);
        });
        const systemSelect = document.getElementById('filter-system');
        Object.values(missionData.systems).forEach(sys => {
            const option = new Option(sys.name, sys.name);
            systemSelect.add(option);
        });
    }

    function generateAndDisplayPlaylist() {
        const playlist = generatePlaylist();
        displayPlaylist(playlist);
        showView('view-results');
    }

    function generatePlaylist() {
        // ... (Steps 1-4 for filtering missionPool and validPlanetIds are the same) ...
        let missionPool = Object.values(missionData.subsystems).filter(sub => !sub.disabled);
        if (userChoices.alignment !== 'any') {
            missionPool = missionPool.filter(sub => sub.alignment.includes(userChoices.alignment));
        }
        const typeId = Object.keys(missionData.missionTypes).find(key => missionData.missionTypes[key].name === userChoices.type);
        if (userChoices.type !== 'any') {
            missionPool = missionPool.filter(sub => sub.parentId === typeId);
        }
        const systemId = Object.keys(missionData.systems).find(key => missionData.systems[key].name === userChoices.system);
        const validPlanetIds = (userChoices.system !== 'any')
            ? Object.keys(missionData.planets).filter(key => missionData.planets[key].parentId === systemId)
            : Object.keys(missionData.planets);

        if (missionPool.length === 0) return [];

        // 5. Build the playlist with new travel logic
        const playlist = [];
        let remainingTime = userChoices.duration;
        let lastPlanetId = null;
        let lastSystemId = null;
        let totalTime = 0;

        while (remainingTime > 0) {
            const availableMissions = missionPool.filter(sub =>
                missionData.links.some(link => link.from === findKey(missionData.subsystems, sub) && validPlanetIds.includes(link.to))
            );
            if(availableMissions.length === 0) break;

            const randomSub = availableMissions[Math.floor(Math.random() * availableMissions.length)];
            const subId = findKey(missionData.subsystems, randomSub);

            const validLinks = missionData.links.filter(link => link.from === subId && validPlanetIds.includes(link.to));
            const randomLink = validLinks[Math.floor(Math.random() * validLinks.length)];
            const planet = missionData.planets[randomLink.to];
            const planetId = randomLink.to;
            const systemId = planet.parentId;

            let travelTime = 0;
            // MODIFICATIONS #5 & #6: Calculate travel time
            if (lastPlanetId) { // If this isn't the first mission
                if (systemId !== lastSystemId) {
                    travelTime = TRAVEL_TIME_CROSS_SYSTEM;
                } else if (planetId !== lastPlanetId) {
                    // Find system name to determine travel time
                    const currentSystem = missionData.systems[systemId];
                    if (currentSystem.name.toLowerCase() === 'stanton') {
                        travelTime = TRAVEL_TIME_STANTON;
                    } else if (currentSystem.name.toLowerCase() === 'pyro') {
                        travelTime = TRAVEL_TIME_PYRO;
                    }
                }
            }

            let missionTime = randomSub.time + travelTime;

            if (remainingTime - missionTime < -10 && playlist.length > 0) break;

            playlist.push({
                subsystem: randomSub,
                planet: planet,
                system: missionData.systems[systemId],
                travelTime: travelTime
            });

            remainingTime -= missionTime;
            totalTime += missionTime;
            lastPlanetId = planetId;
            lastSystemId = systemId;
        }

        playlist.totalTime = totalTime;
        return playlist;
    }

    function displayPlaylist(playlist) {
        const container = document.getElementById('playlist-container');
        const copyBtn = document.getElementById('btn-copy-discord');
        container.innerHTML = '';
        let discordText = '';

        if (playlist.length === 0) {
            container.innerHTML = '<p>Could not generate a playlist with the selected criteria. Try being less restrictive!</p>';
            document.getElementById('total-time-summary').textContent = '';
            copyBtn.style.display = 'none';
            return;
        }

        copyBtn.style.display = 'block';
        discordText += `**Star Citizen Mission Playlist (${playlist.totalTime} mins approx.)**\n`;
        discordText += `> Alignment: ${userChoices.alignment.charAt(0).toUpperCase() + userChoices.alignment.slice(1)}\n\n`;

        playlist.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'mission-card';

            const missionType = missionData.missionTypes[item.subsystem.parentId]?.name || 'Unknown Type';

            let travelInfo = '';
            let locationLabel = (index === 0) ? 'Starting Location:' : 'Location:';

            if (index > 0 && item.travelTime > 0) {
                const previousItem = playlist[index - 1];
                let travelReason = 'new planet';
                if (previousItem && item.system.name !== previousItem.system.name) {
                    travelReason = 'new system';
                }
                travelInfo = `<p><small><em><strong>Travel to ${travelReason}</strong> (Minimum estimated travel time: ${item.travelTime} mins)</em></small></p>`;
            }

            card.innerHTML = `
                <span class="mission-number">#${index + 1}</span>
                <h3>${item.subsystem.name}</h3>
                <p class="mission-type">${missionType}</p>
                
                <div class="card-divider"></div>
    
                ${travelInfo}
                <p><small><strong>${locationLabel}</strong> ${item.planet.name} (${item.system.name})</small></p>
                <p><small><strong>Faction:</strong> ${item.subsystem.faction}</small></p>
                <p><small><strong>Mission Information:</strong> ${item.subsystem.description}</small></p>
            `;
            container.appendChild(card);

            // --- START OF MODIFIED DISCORD TEXT ---
            discordText += `**${index + 1}. ${item.subsystem.name}** (${item.subsystem.time} mins)\n`;

            if (index > 0 && item.travelTime > 0) {
                const previousItem = playlist[index - 1];
                let travelReason = 'new planet';
                if (previousItem && item.system.name !== previousItem.system.name) {
                    travelReason = 'new system';
                }
                discordText += `   - *Travel to ${travelReason} (${item.travelTime} mins)*\n`;
            }

            discordText += `   - **Type:** ${missionType}\n`;
            discordText += `   - **${locationLabel}** ${item.planet.name} (${item.system.name})\n`;
            discordText += `   - **Faction:** ${item.subsystem.faction}\n`;
            discordText += `   - **Brief:** ${item.subsystem.description}\n\n`;
            // --- END OF MODIFIED DISCORD TEXT ---
        });

        copyBtn.dataset.playlistText = discordText;

        document.getElementById('total-time-summary').textContent =
            `Generated ${playlist.length} missions. Estimated total time: ${playlist.totalTime} minutes.`;
    }

    // Helper to find a key by its value object
    function findKey(obj, value) {
        return Object.keys(obj).find(key => obj[key] === value);
    }

    // --- START THE APP ---
    initialize();
});