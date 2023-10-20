require('dotenv').config({ path: '../.env' });
import HLTV from 'hltv';
import * as fs from 'fs';
import * as path from 'path';
import { BlobServiceClient } from '@azure/storage-blob';

// Load the cache
const cacheFilePath = path.join(__dirname, 'teamLogoCache.json');
let teamLogoCache: { [key: number]: string } = {};

// Check if the file exists and is not empty
if (fs.existsSync(cacheFilePath) && fs.statSync(cacheFilePath).size !== 0) {
  try {
    teamLogoCache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
  } catch (error) {
    console.error(`Error reading or parsing teamLogoCache.json: ${error}`);
  }
} else {
  // Initialize an empty cache if the file doesn't exist or is empty
  fs.writeFileSync(cacheFilePath, JSON.stringify({}, null, 2));
}

interface MatchResult {
  matchId: number;
  date: string;
  team1: string;
  team1Logo: string;
  team2: string;
  team2Logo: string;
  hoursUntilMatch: string;
  event: string;
  matchLink: string;
}

let cachedTeamIds: number[] = [];

async function fetchTeamLogo(teamId: number): Promise<{ logoUrl: string, fromCache: boolean }> {
  // Check the cache first
  if (teamLogoCache.hasOwnProperty(teamId)) {
    cachedTeamIds.push(teamId);
    return { logoUrl: teamLogoCache[teamId], fromCache: true };
  }

  console.log(`Fetching CS logo for team ${teamId}`);

  try {
    const teamInfo = await HLTV.getTeam({id: teamId});
    let logoUrl: string;

    if (teamInfo && teamInfo.logo) {
      logoUrl = teamInfo.logo;
    } else {
      console.warn(`Logo is undefined for team ${teamId}`);
      logoUrl = 'Logo not available';
    }

    // Update the cache
    teamLogoCache[teamId] = logoUrl;
    fs.writeFileSync(cacheFilePath, JSON.stringify(teamLogoCache, null, 2));

    return { logoUrl, fromCache: false };

  } catch (error) {
    console.error(`Failed to fetch logo for team ${teamId}: ${error}`);
    return { logoUrl: 'Logo not available', fromCache: false };
  }
}


// Delay function for rate throttling
async function delay(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}


async function fetchUpcomingMatches() {
  const results: MatchResult[] = [];
  const now = new Date();
  const nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  try {
    const matches = await HLTV.getMatches();
    await delay(500);

    for (const match of matches) {
      try {
        const matchDetails = await HLTV.getMatch({ id: match.id });
        await delay(500);

        const eventName = matchDetails.event ? matchDetails.event.name : "Unknown Event";
        const matchDate = match.date ? new Date(match.date) : null;

        // Create URL slugs
        const team1Slug = match.team1 ? match.team1.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'unknown';
        const team2Slug = match.team2 ? match.team2.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'unknown';
        const eventSlug = eventName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        // Construct the full match link
        const matchLink = `https://www.hltv.org/matches/${match.id}/${team1Slug}-vs-${team2Slug}-${eventSlug}`;

        if (!matchDate || (matchDate >= now && matchDate <= nextDay)) {
          const date = match.date ? new Date(match.date).toISOString() : 'Date not specified';
          const team1Name = match.team1 ? match.team1.name : 'Team1 not specified';
          
          // Check if team1 and team1.id are defined before calling fetchTeamLogo
          const team1LogoResult = match.team1 && match.team1.id !== undefined ? await fetchTeamLogo(match.team1.id) : { logoUrl: 'Logo not available', fromCache: true };
          if (!team1LogoResult.fromCache) {
            await delay(500);
          }
          
          const team2Name = match.team2 ? match.team2.name : 'Team2 not specified';
          
          // Check if team2 and team2.id are defined before calling fetchTeamLogo
          const team2LogoResult = match.team2 && match.team2.id !== undefined ? await fetchTeamLogo(match.team2.id) : { logoUrl: 'Logo not available', fromCache: true };
          if (!team2LogoResult.fromCache) {
            await delay(500);
          }

          let hoursUntilMatch = 'N/A';
          if (matchDate) {
            const diffInMilliseconds = matchDate.getTime() - now.getTime();
            const diffInHours = diffInMilliseconds / (1000 * 60 * 60);
            const wholeHours = Math.floor(diffInHours);
            const minutes = Math.round((diffInHours - wholeHours) * 60);
            hoursUntilMatch = `${wholeHours}h : ${minutes}m`;
          }

          results.push({
            matchId: match.id,
            date,
            team1: team1Name,
            team1Logo: team1LogoResult.logoUrl,
            team2: team2Name,
            team2Logo: team2LogoResult.logoUrl,
            hoursUntilMatch,
            event: eventName,
            matchLink
          });
        }
      } catch (error) {
        console.error(`An error occurred while processing match with ID ${match.id}: ${error}`);
      }
    }
    // Log the cached team IDs at the end
    if (cachedTeamIds.length > 0) {
      console.log(`Used cached CS logos for team IDs: ${cachedTeamIds.join(', ')}`);
    }

    fs.writeFileSync('matches.json', JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(`An error occurred while fetching upcoming matches: ${error}`);
  }
}


// Function to upload the JSON file to Azure Blob Storage
async function uploadJsonToBlob() {

  const accountName = process.env.AZURE_ACCOUNT_NAME;  // <-- From environment variable
  const accountKey = process.env.AZURE_ACCOUNT_KEY;    // <-- From environment variable
  if (!accountName || !accountKey) {
    console.error("Azure account name or key is not set in environment variables. Make sure you've added .env to your .gitignore file to avoid committing sensitive information.");
    return;
  }
  const blobServiceClient = BlobServiceClient.fromConnectionString(`DefaultEndpointsProtocol=https;AccountName=${accountName};AccountKey=${accountKey};EndpointSuffix=core.windows.net`);
  
  const containerName = 'hltv';
  const blobName = 'matches.json';
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  const data = fs.readFileSync('matches.json');
  
  await blockBlobClient.upload(data, data.length);
  console.log(`Uploaded ${blobName} successfully!`);
}

// Fetch matches and then upload the JSON to Azure Blob Storage
fetchUpcomingMatches().then(() => {
  uploadJsonToBlob().catch(console.error);
}).catch(console.error);
