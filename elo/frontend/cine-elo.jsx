import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";

const STORAGE_KEY = "cine-elo-movies";
const SYNC_URL_KEY = "cine-elo-sync-url";
const DEFAULT_SYNC_URL =
  "https://script.google.com/macros/s/AKfycbxj4NLejc7vBU17MyuJefuEA8YbjdP0czUNlGN6u96U_fYb1czZMkhUM2k_Y0gpBU0aQg/exec";
const START_ELO = 1200;

// K dinámico: mientras menos duelos lleva una película, más se mueve su elo
// por cada resultado nuevo (todavía estamos "descubriendo" dónde va) — y
// una vez asentada, cada duelo pesa menos. Mismo criterio que usan las
// federaciones de ajedrez con jugadores nuevos vs. establecidos.
function getKFactor(comparisons) {
  if (comparisons < 10) return 32;
  if (comparisons < 30) return 20;
  return 12;
}
const SNAPSHOT_INTERVAL = 25; // guardar posiciones cada N duelos
const MAX_SNAPSHOTS = 15; // tope de cortes guardados en el historial
const SNAPSHOT_TOP_N = 500; // solo se guarda el top 500 en cada corte

function expectedScore(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// --- Torneo / bracket ---

const TOURNAMENT_STORAGE_KEY = "cine-elo-tournament";

function tournamentSeedOrder(size) {
  // Orden clásico de bracket (1 vs N, 4 vs N-3, etc.) para que los
  // mejores sembrados no se crucen hasta rondas avanzadas.
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    const next = [];
    for (const s of order) {
      next.push(s, n + 1 - s);
    }
    order = next;
  }
  return order;
}

function tournamentRoundName(playersInRound) {
  if (playersInRound <= 2) return "Final";
  if (playersInRound === 4) return "Semifinal";
  if (playersInRound === 8) return "Cuartos de final";
  if (playersInRound === 16) return "Octavos de final";
  if (playersInRound === 32) return "Dieciseisavos de final";
  return `Ronda de ${playersInRound}`;
}

function createTournament(entrants, size) {
  const order = tournamentSeedOrder(size);
  const round0 = [];
  for (let i = 0; i < order.length; i += 2) {
    round0.push({
      a: entrants[order[i] - 1].id,
      b: entrants[order[i + 1] - 1].id,
      winner: null,
    });
  }
  const rounds = [round0];
  let matchesInRound = round0.length;
  while (matchesInRound > 1) {
    matchesInRound = matchesInRound / 2;
    const round = [];
    for (let i = 0; i < matchesInRound; i++) {
      round.push({ a: null, b: null, winner: null });
    }
    rounds.push(round);
  }
  return { size, rounds, champion: null, createdAt: Date.now() };
}

function advanceTournament(tournament, roundIdx, matchIdx, winnerId) {
  const rounds = tournament.rounds.map((r) => r.map((m) => ({ ...m })));
  rounds[roundIdx][matchIdx].winner = winnerId;
  let champion = tournament.champion;
  if (roundIdx + 1 < rounds.length) {
    const nextMatchIdx = Math.floor(matchIdx / 2);
    const slot = matchIdx % 2 === 0 ? "a" : "b";
    rounds[roundIdx + 1][nextMatchIdx][slot] = winnerId;
  } else {
    champion = winnerId;
  }
  return { ...tournament, rounds, champion };
}

function findCurrentTournamentMatch(tournament) {
  for (let r = 0; r < tournament.rounds.length; r++) {
    for (let m = 0; m < tournament.rounds[r].length; m++) {
      const match = tournament.rounds[r][m];
      if (match.winner == null && match.a != null && match.b != null) {
        return { roundIdx: r, matchIdx: m, match };
      }
    }
  }
  return null;
}

// [title, year, rating (0-5 stars), plays (veces vista), director, genre, poster_path, tmdbId]
const TMDB_POSTER_BASE = "https://image.tmdb.org/t/p/w342";
const SEED_MOVIES = [["Four Rooms",1995,2,1,"Robert Rodriguez","Comedy","75aHn1NOYXh4M7L5shoeQ6NGykP.jpg",5],["Star Wars",1977,4.5,5,"George Lucas","Adventure, Action, Science Fiction","6FfCtAuVAW8XJjZ7eWeLibRLWTw.jpg",11],["Finding Nemo",2003,4.5,4,"Andrew Stanton","Animation, Family, Adventure","axyrDKJmQpynKOESqxO2wKmhj9n.jpg",12],["Forrest Gump",1994,4.5,3,"Robert Zemeckis","Comedy, Drama, Romance","saHP97rTPS5eLmrLQEcANmKrsFl.jpg",13],["American Beauty",1999,4,2,"Sam Mendes","Drama","wby9315QzVKdW9BonAefg8jGTTb.jpg",14],["Citizen Kane",1941,5,1,"Orson Welles","Mystery, Drama","sav0jxhqiH0bPr2vZFU0Kjt2nZL.jpg",15],["Dancer in the Dark",2000,4.5,1,"Lars von Trier","Drama, Crime","pWzOfTJRZHPNO1VNrMnNFqRcJwg.jpg",16],["The Fifth Element",1997,4,3,"Luc Besson","Science Fiction, Action, Adventure","fPtlCO1yQtnoLHOwKtWz7db6RGU.jpg",18],["Metropolis",1927,4.5,1,"Fritz Lang","Drama, Science Fiction","kr9wXRN23zLuWJIelahas1mtnYj.jpg",19],["Pirates of the Caribbean: The Curse of the Black Pearl",2003,4,3,"Gore Verbinski","Adventure, Fantasy, Action","poHwCZeWzJCShH7tOjg8RIoyjcw.jpg",22],["Kill Bill: Vol. 1",2003,5,5,"Quentin Tarantino","Action, Crime","v7TaX8kXMXs5yFFGR41guUDNcnB.jpg",24],["Jarhead",2005,3,1,"Sam Mendes","Drama, War","6vdj47RAWOUZBkeQmqToeZ7eaio.jpg",25],["Apocalypse Now",1979,5,3,"Francis Ford Coppola","Drama, War","gQB8Y5RCMkv2zwzFHbUJX3kAhvA.jpg",28],["Unforgiven",1992,4.5,1,"Clint Eastwood","Western","54roTwbX9fltg85zjsmrooXAs12.jpg",33],["The Simpsons Movie",2007,3,2,"David Silverman","Animation, Comedy, Family","s3b8TZWwmkYc2KoJ5zk77qB6PzY.jpg",35],["Eternal Sunshine of the Spotless Mind",2004,5,2,"Michel Gondry","Science Fiction, Drama, Romance","5MwkWH9tYHv3mV9OdYTMR5qreIz.jpg",38],["Amores Perros",2000,5,2,"Alejandro G. Iñárritu","Drama, Thriller","A4lH22nlFF7MdalGfcvSrlC1ttt.jpg",55],["Pirates of the Caribbean: Dead Man's Chest",2006,3.5,2,"Gore Verbinski","Adventure, Fantasy, Action","uXEqmloGyP7UXAiphJUu2v2pcuE.jpg",58],["A History of Violence",2005,4.5,1,"David Cronenberg","Drama, Thriller, Crime","A26rcvipOqptVs7i5uRmKicXRxE.jpg",59],["2001: A Space Odyssey",1968,5,4,"Stanley Kubrick","Science Fiction, Mystery, Adventure","ve72VxNqjGM69Uky4WTo2bK6rfq.jpg",62],["Twelve Monkeys",1995,4,1,"Terry Gilliam","Science Fiction, Thriller, Mystery","gt3iyguaCIw8DpQZI1LIN5TohM2.jpg",63],["Talk to Her",2002,4.5,1,"Pedro Almodóvar","Drama, Romance","fWDbQlOWOqjR5jZm98KjGyYmUOw.jpg",64],["8 Mile",2002,2.5,1,"Curtis Hanson","Drama, Music","7BmQj8qE1FLuLTf7Xjf9sdIHzoa.jpg",65],["Brazil",1985,5,1,"Terry Gilliam","Comedy, Science Fiction","aewan59WcFThBimkTVVoNf2o5Vb.jpg",68],["Walk the Line",2005,3.5,1,"James Mangold","Drama, Music, Romance","p8lPTjvjOjTfvC1E9pmMwcF9vkn.jpg",69],["Million Dollar Baby",2004,4.5,1,"Clint Eastwood","Drama","jcfEqKdWF1zeyvECPqp3mkWLct2.jpg",70],["Billy Elliot",2000,3.5,1,"Stephen Daldry","Drama, Comedy, Music","nOr5diUZxphmAD3li9aiILyI28F.jpg",71],["American History X",1998,4,1,"Tony Kaye","Drama","x2drgoXYZ8484lqyDj7L1CEVR4T.jpg",73],["War of the Worlds",2005,2.5,1,"Steven Spielberg","Adventure, Thriller, Science Fiction","6Biy7R9LfumYshur3YKhpj56MpB.jpg",74],["Mars Attacks!",1996,3.5,1,"Tim Burton","Comedy, Fantasy, Science Fiction","vUbGCNSEilGvxRQZi2kfTPRP0pS.jpg",75],["Before Sunrise",1995,4,2,"Richard Linklater","Drama, Romance","kf1Jb1c2JAOqjuzA3H4oDM263uB.jpg",76],["Memento",2000,4.5,1,"Christopher Nolan","Mystery, Thriller","fKTPH2WvH8nHTXeBYBVhawtRqtR.jpg",77],["Blade Runner",1982,4.5,4,"Ridley Scott","Science Fiction, Drama, Thriller","63N9uy8nd9j7Eog2axPQ8lbr3Wj.jpg",78],["Hero",2002,4,1,"Zhang Yimou","Drama, Adventure, Action, History","vxgZto2Cz7ILHAlmRXt50I2brB2.jpg",79],["Before Sunset",2004,5,2,"Richard Linklater","Drama, Romance","gycdE1ARByGQcK4fYR2mgpU6OO.jpg",80],["Nausicaä of the Valley of the Wind",1984,3.5,1,"Hayao Miyazaki","Adventure, Animation, Fantasy","tcrkfB8SRPQCgwI88hQScua6nxh.jpg",81],["Raiders of the Lost Ark",1981,4.5,3,"Steven Spielberg","Adventure, Action","ceG9VzoRAVGwivFU403Wc3AHRys.jpg",85],["Indiana Jones and the Temple of Doom",1984,3,1,"Steven Spielberg","Adventure, Action","gpdVNUaa4LhRMLfJOPj1AZdhAZ3.jpg",87],["Dirty Dancing",1987,2,1,"Emile Ardolino","Drama, Music, Romance","9Jw6jys7q9gjzVX5zm1z0gC8gY9.jpg",88],["Indiana Jones and the Last Crusade",1989,4,2,"Steven Spielberg","Adventure, Action","sizg1AU8f8JDZX4QIgE4pjUMBvx.jpg",89],["Beverly Hills Cop",1984,2.5,1,"Martin Brest","Comedy, Crime, Action","eBJEvKkhQ0tUt1dBAcTEYW6kCle.jpg",90],["Land Without Bread",1933,2.5,1,"Luis Buñuel","Documentary","nTizDiDbiVPCGqC6uMVDp8GoEeP.jpg",91],["Anatomy of a Murder",1959,4,1,"Otto Preminger","Crime, Drama, Mystery","b2G1QSAwtBv9luhEwErIgSRaU92.jpg",93],["Armageddon",1998,2,1,"Michael Bay","Action, Science Fiction, Adventure","eTM3qtGhDU8cvjpoa6KEt5E2auU.jpg",95],["Tron",1982,3,1,"Steven Lisberger","Science Fiction, Action, Adventure","jigY9B6TKz4qlfikZcd18qtzTK4.jpg",97],["Gladiator",2000,4,1,"Ridley Scott","Action, Drama, Adventure","ty8TGRuvJLPUmAR1H1nRIsgwvim.jpg",98],["All About My Mother",1999,5,4,"Pedro Almodóvar","Comedy, Drama","hjQhzhkGYXPNM96k0mOgob6HMmn.jpg",99],["Lock, Stock and Two Smoking Barrels",1998,4,1,"Guy Ritchie","Comedy, Crime","6pJB2t3MbQUy9m5pFIBHXLqnqNd.jpg",100],["Léon: The Professional",1994,3.5,2,"Luc Besson","Crime, Drama, Action","bxB2q91nKYp8JNzqE7t7TWBVupB.jpg",101],["Taxi Driver",1976,5,6,"Martin Scorsese","Crime, Drama","ekstpH614fwDX8DUln1a2Opz0N8.jpg",103],["Run Lola Run",1998,4,1,"Tom Tykwer","Action, Drama, Thriller","v0giIi4bTILVhNhJajet3WWY3FA.jpg",104],["Back to the Future",1985,5,6,"Robert Zemeckis","Adventure, Comedy, Science Fiction","vN5B5WgYscRGcQpVhHl6p9DDTP0.jpg",105],["Predator",1987,3.5,1,"John McTiernan","Science Fiction, Action, Adventure, Thriller","k3mW4qfJo6SKqe6laRyNGnbB9n5.jpg",106],["Snatch",2000,4,1,"Guy Ritchie","Crime, Comedy","kJZoAHq1SLDdWjeNGtlHAnGpmFV.jpg",107],["Three Colours: Blue",1993,5,4,"Krzysztof Kieślowski","Drama","33wsWxzsNstI8N7dvuwzFmj1qBd.jpg",108],["Three Colours: White",1994,4,2,"Krzysztof Kieślowski","Comedy, Drama, Mystery","fdIet3NSa27gobMbaUml66oCQNT.jpg",109],["Three Colours: Red",1994,5,2,"Krzysztof Kieślowski","Drama, Mystery, Romance","JHmsBiX1tjCKqAul1lzC20WcAW.jpg",110],["Scarface",1983,4,2,"Brian De Palma","Action, Crime, Drama","iQ5ztdjvteGeboxtmRdXEChJOHh.jpg",111],["Spring, Summer, Fall, Winter... and Spring",2003,4.5,1,"Kim Ki-duk","Drama","xw8aVnN6j5zMJSurOI8CEmZZqhU.jpg",113],["Pretty Woman",1990,2.5,1,"Garry Marshall","Romance, Comedy","hVHUfT801LQATGd26VPzhorIYza.jpg",114],["The Big Lebowski",1998,5,4,"Joel Coen & Ethan Coen","Comedy, Crime","9mprbw31MGdd66LR0AQKoDMoFRv.jpg",115],["Match Point",2005,4.5,1,"Woody Allen","Drama, Romance, Thriller","vHjEVTD8ucuwKSFOZJeyAnTZYli.jpg",116],["The Untouchables",1987,4,1,"Brian De Palma","Crime, History, Thriller","8BquGK22zCcsmBWiaIakaaPpSZb.jpg",117],["Charlie and the Chocolate Factory",2005,3,1,"Tim Burton","Adventure, Comedy, Family, Fantasy","iKP6wg3c6COUe8gYutoGG7qcPnO.jpg",118],["The Lord of the Rings: The Fellowship of the Ring",2001,5,4,"Peter Jackson","Adventure, Fantasy, Action","6oom5QYQ2yQTMJIbnvbkBL9cHo6.jpg",120],["The Lord of the Rings: The Two Towers",2002,4.5,3,"Peter Jackson","Adventure, Fantasy, Action","5VTN0pR8gcqV3EPUHHfMGnJYN9L.jpg",121],["The Lord of the Rings: The Return of the King",2003,4.5,3,"Peter Jackson","Adventure, Fantasy, Action","rCzpDGLbOoPwLjy3OAm5NUPOTrC.jpg",122],["Princess Mononoke",1997,4,1,"Hayao Miyazaki","Adventure, Fantasy, Animation","cMYCDADoLKLbB83g4WnJegaZimC.jpg",128],["Spirited Away",2001,5,2,"Hayao Miyazaki","Animation, Family, Fantasy","39wmItIWsg5sZMyRUHLkWBcuVCM.jpg",129],["O Brother, Where Art Thou?",2000,4,2,"Joel Coen & Ethan Coen","Adventure, Comedy, Crime","s9foMAcLg8GEzzQzer04qOGdD1k.jpg",134],["Freaks",1932,4,1,"Tod Browning","Drama, Horror","fX2Wxd0W9E7eVClUd8kJTfennoV.jpg",136],["Groundhog Day",1993,4.5,4,"Harold Ramis","Romance, Fantasy, Comedy","gCgt1WARPZaXnq523ySQEUKinCs.jpg",137],["Dracula",1931,3,1,"Tod Browning","Horror","ueVSPt7vAba0XScHWTDWS5tNxYX.jpg",138],["Bad Education",2004,3.5,1,"Pedro Almodóvar","Drama, Crime","du716YH0PKiL2kZgIPLkEblgHLX.jpg",140],["Donnie Darko",2001,4,3,"Richard Kelly","Fantasy, Drama, Mystery","fhQoQfejY1hUcwyuLgpBrYs6uFt.jpg",141],["Brokeback Mountain",2005,4.5,1,"Ang Lee","Drama, Romance","aByfQOQBNa4CMFwIgq3QrqY2ZHh.jpg",142],["All Quiet on the Western Front",1930,3,1,"Lewis Milestone","Drama, War","1wZUB08igw8iLUgF1r4T6aJD65b.jpg",143],["Wings of Desire",1987,3,1,"Wim Wenders","Drama, Fantasy, Romance","iZQs2vUeCzvS1KfZJ6uYNCGJBBV.jpg",144],["Breaking the Waves",1996,4,1,"Lars von Trier","Drama, Romance","dQWMcdHXUOSHtr7ypOCa5T79JMS.jpg",145],["Crouching Tiger, Hidden Dragon",2000,4,1,"Ang Lee","Drama, Romance, Action, Adventure","iNDVBFNz4XyYzM9Lwip6atSTFqf.jpg",146],["The 400 Blows",1959,4,1,"François Truffaut","Drama","12PuU23kkDLvTd0nb8hMlE3oShB.jpg",147],["Akira",1988,4,1,"Katsuhiro Otomo","Animation, Science Fiction, Action","neZ0ykEsPqxamsX6o5QNUFILQrz.jpg",149],["Lost in Translation",2003,4.5,1,"Sofia Coppola","Drama, Comedy, Romance","3jCLmYDIIiSMPujbwygNpqdpM8N.jpg",153],["The Dark Knight",2008,4.5,2,"Christopher Nolan","Action, Crime, Thriller","qJ2tW6WMUDux911r6m7haRef0WH.jpg",155],["The Arrival of a Train at La Ciotat",1896,2.5,1,"Louis Lumière","History","m5HSlaNCzwV95rAriDmT19el5h1.jpg",160],["Ocean's Eleven",2001,4,1,"Steven Soderbergh","Thriller, Crime","hQQCdZrsHtZyR6NbKH2YyCqd2fR.jpg",161],["Edward Scissorhands",1990,4.5,3,"Tim Burton","Fantasy, Drama, Romance","e0FqKFvGPdQNWG8tF9cZBtev9Em.jpg",162],["Ocean's Twelve",2004,2,1,"Steven Soderbergh","Thriller, Crime","pE5anFf7nf6ah7V3VRezQ1KSovi.jpg",163],["Breakfast at Tiffany's",1961,4,1,"Blake Edwards","Comedy, Romance, Drama","79xm4gXw4l7A5D0XukUOJRocFYQ.jpg",164],["Back to the Future Part II",1989,4.5,4,"Robert Zemeckis","Adventure, Comedy, Science Fiction","YBawEsTkUZBDajKbd5LiHkmMGf.jpg",165],["K-PAX",2001,2,1,"Iain Softley","Science Fiction, Drama, Mystery","tafXZX0I6rso7EyoEzfygfTqxq6.jpg",167],["Predator 2",1990,2,1,"Stephen Hopkins","Science Fiction, Action, Thriller","83X4VwY9sdSJykskmsplIVG0a4h.jpg",169],["28 Days Later",2002,3.5,1,"Danny Boyle","Horror, Thriller, Science Fiction","sQckQRt17VaWbo39GIu0TMOiszq.jpg",170],["Saw",2004,3,1,"James Wan","Horror, Mystery, Crime","rLNSOudrayDBo1uqXjrhxcjODIC.jpg",176],["The Fisher King",1991,3.5,1,"Terry Gilliam","Comedy, Drama","hwIYw22HmAUMobV4zsX69MgfVUz.jpg",177],["Minority Report",2002,3.5,1,"Steven Spielberg","Science Fiction, Action, Thriller","qtgFcnwh9dAFLocsDk2ySDVS8UF.jpg",180],["Jackie Brown",1997,4,1,"Quentin Tarantino","Crime, Drama, Thriller","rOUx7qg4KmEh1juEDwqzbDSL1Nr.jpg",184],["A Clockwork Orange",1971,4.5,3,"Stanley Kubrick","Science Fiction, Crime","4sHeTAp65WrSSuc05nRBKddhBxO.jpg",185],["Sin City",2005,4,1,"Robert Rodriguez","Crime, Thriller","i66G50wATMmPrvpP95f0XP6ZdVS.jpg",187],["The Name of the Rose",1986,3.5,1,"Jean-Jacques Annaud","Drama, Thriller, Mystery","d6dlbTBb3N7nXDz7tQslDJs2jgv.jpg",192],["Amélie",2001,4.5,2,"Jean-Pierre Jeunet","Comedy, Romance","nSxDa3M9aMvGVLoItzWTepQ5h5d.jpg",194],["Back to the Future Part III",1990,3.5,4,"Robert Zemeckis","Adventure, Comedy, Science Fiction","crzoVQnMzIrRfHtQw0tLBirNfVg.jpg",196],["Braveheart",1995,4,1,"Mel Gibson","Action, Drama, History, War","or1gBugydmjToAEq7OZY0owwFk.jpg",197],["To Be or Not to Be",1942,4,1,"Ernst Lubitsch","Comedy, War, Romance","dDQRpEoyjHT4fzw9cNklIvZuXYg.jpg",198],["Mean Streets",1973,4,1,"Martin Scorsese","Drama, Crime","9msfwOeGc9uL1iRRTBdEf15XonC.jpg",203],["The Wages of Fear",1953,3.5,1,"Henri-Georges Clouzot","Drama, Thriller, Adventure","dZyZSosIlWcpQkV0f7pXcrV2TQV.jpg",204],["Hotel Rwanda",2004,3.5,1,"Terry George","Drama, History, War","p3pHw85UMZPegfMZBA6dZ06yarm.jpg",205],["Dead Poets Society",1989,4,1,"Peter Weir","Drama","l5NbiHKUmahlAT3Q1ig8Tyl9xrc.jpg",207],["Arsenic and Old Lace",1944,3.5,1,"Frank Capra","Comedy, Crime","xG1GEEQGgExKl0WT5sRo1Arst5D.jpg",212],["North by Northwest",1959,4.5,1,"Alfred Hitchcock","Thriller, Adventure","kNOFPQrel9YFCVzI0DF8FnCEpCw.jpg",213],["Saw III",2006,2,1,"Darren Lynn Bousman","Horror, Thriller, Crime","4iO9n24Rb10peXV0JH2EldIOrAp.jpg",214],["Saw II",2005,2.5,1,"Darren Lynn Bousman","Horror","gTnaTysN8HsvVQqTRUh8m35mmUA.jpg",215],["Indiana Jones and the Kingdom of the Crystal Skull",2008,2,1,"Steven Spielberg","Adventure, Action","56As6XEM1flWvprX4LgkPl8ii4K.jpg",217],["The Terminator",1984,4,1,"James Cameron","Action, Thriller, Science Fiction","qvktm0BHcnmDpul4Hz01GIazWPr.jpg",218],["Volver",2006,4,1,"Pedro Almodóvar","Comedy, Drama, Romance","m1ZUDGTFtVGE3zjTvF8OiQ9um5e.jpg",219],["East of Eden",1955,4.5,2,"Elia Kazan","Drama","xv1MZVIop0SQqwLUymgE5eb2LFl.jpg",220],["Rebel Without a Cause",1955,3.5,1,"Nicholas Ray","Drama","yHStsC8rRRfIjqRN38BQsLh6S7k.jpg",221],["Rebecca",1940,4.5,1,"Alfred Hitchcock","Mystery, Romance, Drama","1qz3qUOHnVy7dL7M7G8jSErxE4b.jpg",223],["The Outsiders",1983,3,1,"Francis Ford Coppola","Crime, Drama","l9os0HcXY8BOkvUWAx4rvby3j6L.jpg",227],["Bride of Frankenstein",1935,3.5,1,"James Whale","Horror, Science Fiction","5241zUwe7rC17MNc2QpCBKKdp1N.jpg",229],["Rumble Fish",1983,3.5,1,"Francis Ford Coppola","Crime, Drama, Romance","vwMfVhBwAcRT7K0xjFrNoNf9YRb.jpg",232],["The Cabinet of Dr. Caligari",1920,4,1,"Robert Wiene","Crime, Drama, Thriller, Horror","myK9DeIsXWGKgUTZyGXg2IfFk0W.jpg",234],["Stand by Me",1986,4,1,"Rob Reiner","Drama, Adventure","vz0w9BSehcqjDcJOjRaCk7fgJe7.jpg",235],["Muriel's Wedding",1994,3.5,1,"P.J. Hogan","Comedy, Drama, Romance","zJyTr8Fo412a2OIfJGXTRAm4IwX.jpg",236],["The Godfather",1972,5,6,"Francis Ford Coppola","Crime, Drama","3bhkrj58Vtu7enYsRolD1fZdja1.jpg",238],["Some Like It Hot",1959,4,1,"Billy Wilder","Comedy, Romance, Crime","hVIKyTK13AvOGv7ICmJjK44DTzp.jpg",239],["The Godfather Part II",1974,5,4,"Francis Ford Coppola","Drama, Crime","hek3koDUyRQk7FIhPXsa6mT2Zc3.jpg",240],["Natural Born Killers",1994,3.5,1,"Oliver Stone","Crime, Thriller, Drama","fEKZwT91gxvkAoyPgpNXo8W5fu0.jpg",241],["The Godfather Part III",1990,3,1,"Francis Ford Coppola","Crime, Drama, Thriller","lm3pQ2QoQ16pextRsmnUbG2onES.jpg",242],["High Fidelity",2000,4,1,"Stephen Frears","Drama, Comedy, Romance, Music","e2LZGB62GMhv3Fo8tDZjY87I81a.jpg",243],["King Kong",1933,3,1,"Merian C. Cooper","Adventure, Fantasy, Horror","lHlnxKL5GbgRibyRFI7n1Ey850i.jpg",244],["About a Boy",2002,2.5,1,"Chris Weitz","Drama, Comedy, Romance","qoZ1bD0q9EFqcNiEYbEigsRcNCt.jpg",245],["The Killing",1956,4.5,1,"Stanley Kubrick","Crime, Thriller, Drama","A6VzUPcADZGYdGHlVdWvpMNDF5d.jpg",247],["Ghost",1990,3,1,"Jerry Zucker & David Zucker & Jim Abrahams","Fantasy, Romance, Thriller","w9RaPHov8oM5cnzeE27isnFMsvS.jpg",251],["Willy Wonka & the Chocolate Factory",1971,3,1,"Mel Stuart","Family, Fantasy, Comedy","vmpsZkrs4Uvkp9r1atL8B3frA63.jpg",252],["Live and Let Die",1973,2,1,"Guy Hamilton","Adventure, Action, Thriller","39qkrjqMZs6utwNmihVImC3ghas.jpg",253],["King Kong (2005)",2005,3.5,1,"Peter Jackson","Adventure, Drama, Action","6a2HY6UmD7XiDD3NokgaBAXEsD2.jpg",254],["Antoine and Colette",1962,3.5,1,"François Truffaut","Romance, Drama, Comedy","nfP8J7pv75KOAliIM3RG7h6Zos5.jpg",256],["The 39 Steps",1935,3.5,1,"Alfred Hitchcock","Mystery, Thriller","oC81jK6aAug4MA0xzYVngHmjsZS.jpg",260],["Cat on a Hot Tin Roof",1958,4,1,"Richard Brooks","Drama","5djZZECgqDGuSI1INmrdAcGRBb0.jpg",261],["The King of Comedy",1982,5,2,"Martin Scorsese","Drama, Comedy","3sGuQv0UxfjDODCC9IQG5S1jXK8.jpg",262],["Contempt",1963,4,1,"Jean-Luc Godard","Drama, Romance","kNElbRcp4Qz6wmJ9kH5vdY004Hq.jpg",266],["Live Flesh",1997,3,1,"Pedro Almodóvar","Drama, Romance, Thriller","7YPGYeamF6AuyxhKqbd5oNKKCCy.jpg",267],["Batman (1989)",1989,3,1,"Tim Burton","Fantasy, Action, Crime","cij4dd21v2Rk2YtUQbV5kW69WB2.jpg",268],["Breathless",1960,3.5,1,"Jean-Luc Godard","Drama, Crime, Romance","9Wx0Wdn2EOqeCZU4SP6tlS3LOml.jpg",269],["Batman Begins",2005,4,2,"Christopher Nolan","Drama, Crime, Action","sPX89Td70IDDjVr85jdSBb4rWGr.jpg",272],["The Silence of the Lambs",1991,5,2,"Jonathan Demme","Crime, Thriller, Drama","uS9m8OBk1A8eM9I042bx8XXpqAq.jpg",274],["Fargo",1996,4.5,2,"Joel Coen & Ethan Coen","Crime, Drama, Thriller","rt7cpEr1uP6RTZykBFhBTcRaKvG.jpg",275],["The Shawshank Redemption",1994,5,2,"Frank Darabont","Drama, Crime","9cqNxx0GxF0bflZmeSMuL5tnGzr.jpg",278],["Amadeus",1984,5,2,"Miloš Forman","Drama, History, Music","gQRfiyfGvr1az0quaYyMram3Aqt.jpg",279],["Terminator 2: Judgment Day",1991,4.5,4,"James Cameron","Action, Thriller, Science Fiction","jFTVD4XoWQTcg7wdyJKa8PEds5q.jpg",280],["Strange Days",1995,2.5,1,"Kathryn Bigelow","Crime, Science Fiction, Thriller","rY5BrDRcYAKE0BYmmT66YG6Uy5Q.jpg",281],["The Apartment",1960,5,2,"Billy Wilder","Comedy, Drama, Romance","hhSRt1KKfRT0yEhEtRW3qp31JFU.jpg",284],["Pirates of the Caribbean: At World's End",2007,3.5,1,"Gore Verbinski","Adventure, Fantasy, Action","jGWpG4YhpQwVmjyHEGkxEkeRf0S.jpg",285],["High Noon",1952,4.5,2,"Fred Zinnemann","Western","qETSMQ4IXBSAS409Z9OL0ppXWTW.jpg",288],["Casablanca",1942,5,2,"Michael Curtiz","Drama, Romance","lGCEKlJo2CnWydQj7aamY7s1S7Q.jpg",289],["Barton Fink",1991,4,1,"Joel Coen & Ethan Coen","Comedy, Drama, Thriller","oDkp5iClJ9WKJGtKHz8BydodHC3.jpg",290],["Desert Hearts",1985,3,1,"Donna Deitch","Drama, Romance","klAHoWOZgL8sR74Tnl7K7z4Lziq.jpg",294],["Terminator 3: Rise of the Machines",2003,2,1,"Jonathan Mostow","Action, Thriller, Science Fiction","vvevzdYIrk2636maNW4qeWmlPFG.jpg",296],["Meet Joe Black",1998,1.5,1,"Martin Brest","Fantasy, Drama, Romance","fDPAjvfPMomkKF7cMRmL5Anak61.jpg",297],["Ocean's Thirteen",2007,2.5,1,"Steven Soderbergh","Crime, Thriller","pBsZs4zYUiUTemqbikTZ76iQRaU.jpg",298],["The Science of Sleep",2006,2.5,1,"Michel Gondry","Comedy, Drama, Fantasy","8bummqwU6MV65ZJvNtKx8Y3NIEk.jpg",300],["Rio Bravo",1959,4,1,"Howard Hawks","Western, Drama","4gI4KKmoi0d3yfsF71YU3S0I5t8.jpg",301],["Notorious",1946,4,1,"Alfred Hitchcock","Thriller, Romance, Mystery, Drama","4RERYb1NIQrJHYY5e8nUlYM7t2z.jpg",303],["Rome, Open City",1945,3.5,1,"Roberto Rossellini","Drama, War","ijGV4v8JxgbNzgEhqKdzHdaZn8a.jpg",307],["Broken Flowers",2005,4,1,"Jim Jarmusch","Comedy, Drama, Mystery, Romance","gd8JNjwgiM6ZgGm6NFAkovQWoYn.jpg",308],["The Celebration",1998,4.5,1,"Thomas Vinterberg","Drama","2LRzNq41yrY8EjCnD1S8sCCPvKk.jpg",309],["Bruce Almighty",2003,3.5,3,"Tom Shadyac","Fantasy, Comedy","f0QqG14SZYYZcV4VWykVc5w13dz.jpg",310],["Once Upon a Time in America",1984,5,2,"Sergio Leone","Drama, Crime","i0enkzsL5dPeneWnjl1fCWm6L7k.jpg",311],["Catwoman",2004,0.5,1,"Pitof","Action, Fantasy, Crime","pvnPgukFyEKgCzyOxyLiwyZ8T1C.jpg",314],["True Romance",1993,3.5,1,"Tony Scott","Action, Crime, Romance","39lXk6ud6KiJgGbbWI2PUKS7y2.jpg",319],["Insomnia",2002,3,1,"Christopher Nolan","Thriller, Crime, Drama","riVXh3EimGO0y5dgQxEWPRy5Itg.jpg",320],["Mystic River",2003,4.5,1,"Clint Eastwood","Thriller, Crime, Drama, Mystery","hCHVDbo6XJGj3r2i4hVjKhE0GKF.jpg",322],["Snakes on a Plane",2006,2,1,"David R. Ellis","Action, Adventure, Crime, Horror, Thriller","i0ynvZ89tV1t8MAL9FmeQELfXH0.jpg",326],["Brother",2000,3.5,1,"Takeshi Kitano","Crime, Drama, Thriller","h7UKdWriX8keKOgSlBrk4OG7XRL.jpg",327],["Jurassic Park",1993,4.5,4,"Steven Spielberg","Adventure, Science Fiction","maFjKnJ62hDQ9E66dKqDZgbUy0H.jpg",329],["The Lost World: Jurassic Park",1997,3.5,1,"Steven Spielberg","Adventure, Action, Science Fiction","6fSkhv35nPSw9hwPVCMINQFG1WD.jpg",330],["Jurassic Park III",2001,2,1,"Joe Johnston","Adventure, Thriller, Science Fiction, Action","oQXj4NUfS3r3gHXtDOzcJgj1lLc.jpg",331],["Inspector Gadget",1999,1,1,"David Kellogg","Action, Adventure, Comedy, Family","dDcsv1Lql5aM6H4JYfDHjBAXKgT.jpg",332],["Magnolia",1999,5,4,"Paul Thomas Anderson","Drama","uq2u8HgtLFJkjNq2kHb2jvipIPT.jpg",334],["Once Upon a Time in the West",1968,5,2,"Sergio Leone","Drama, Western","qbYgqOczabWNn2XKwgMtVrntD6P.jpg",335],["Duck, You Sucker",1971,3.5,1,"Sergio Leone","Western","l91bdMjPYUXRLjOnBosxCGickKa.jpg",336],["Good Bye, Lenin!",2003,4,1,"Wolfgang Becker","Comedy, Drama","uHk1oGEbnvQGLnyiiYxTslZLoog.jpg",338],["Night on Earth",1991,3.5,1,"Jim Jarmusch","Comedy, Drama","ktejUHCo6c8DekpOtR3uSb6oDXr.jpg",339],["Harold and Maude",1971,5,3,"Hal Ashby","Comedy, Drama, Romance","t7qEuGwDjcYu8ajaKZ68DeDnOxw.jpg",343],["Eyes Wide Shut",1999,4.5,1,"Stanley Kubrick","Drama, Thriller, Mystery","knEIz1eNGl5MQDbrEAVWA7iRqF9.jpg",345],["Seven Samurai",1954,4.5,1,"Akira Kurosawa","Action, Drama","lOMGc8bnSwQhS4XyE1S99uH8NXf.jpg",346],["Alien",1979,4.5,2,"Ridley Scott","Horror, Science Fiction","vfrQk5IPloGg1v9Rzbh2Eg3VGyM.jpg",348],["The Devil Wears Prada",2006,3.5,1,"David Frankel","Drama, Comedy","8912AsVuS7Sj915apArUFbv6F9L.jpg",350],["Batman Returns",1992,3.5,1,"Tim Burton","Action, Fantasy","jKBjeXM7iBBV9UkUcOXx3m7FSHY.jpg",364],["A Nightmare on Elm Street",1984,4,1,"Wes Craven","Horror","avHGIO93jgCZLf33ec2aahgZJX6.jpg",377],["Raising Arizona",1987,4,1,"Joel Coen & Ethan Coen","Comedy, Crime","niKyjOqiB4XVl0BqgKTHIlHOCeF.jpg",378],["Miller's Crossing",1990,4,1,"Joel Coen & Ethan Coen","Drama, Thriller, Crime","ab3pnsTKp3BgcAFy0FgWBFBg9FL.jpg",379],["Rain Man",1988,3.5,1,"Barry Levinson","Drama","iTNHwO896WKkaoPtpMMS74d8VNi.jpg",380],["To Catch a Thief",1955,3.5,1,"Alfred Hitchcock","Mystery, Romance, Thriller","6M6NwjV3XvtayljoiZ8wRHOKCQG.jpg",381],["Das Boot",1981,3.5,1,"Wolfgang Petersen","Drama, History, War","u8FhQPncOAkwcei2OI9orPWhV6K.jpg",387],["Inside Man",2006,3.5,1,"Spike Lee","Crime, Drama, Thriller","ffMUgkDZICNiyaws1Jkv8qG8uFW.jpg",388],["12 Angry Men",1957,5,2,"Sidney Lumet","Drama","ow3wq89wM8qd5X7hWKxiRfsFf9C.jpg",389],["A Fistful of Dollars",1964,4,2,"Sergio Leone","Western","lBwOEpwVeUAmrmglcstnaGcJq3Y.jpg",391],["Kill Bill: Vol. 2",2004,4,3,"Quentin Tarantino","Action, Crime, Thriller","2yhg0mZQMhDyvUQ4rG1IZ4oIA8L.jpg",393],["Who's Afraid of Virginia Woolf?",1966,4.5,1,"Mike Nichols","Drama","wF7ihB5V5gSm6zxjv3ZhHOpgREI.jpg",396],["Capote",2005,3.5,1,"Bennett Miller","Crime, Drama","tzsxkZMnJvozpHQEl1KzO8KwWu.jpg",398],["Garden State",2004,3,1,"Zach Braff","Comedy, Drama, Romance","h3iqYiGS6F3y7GxaS4AT8nFxZ2i.jpg",401],["Basic Instinct",1992,3.5,1,"Paul Verhoeven","Thriller, Mystery","76Ts0yoHk8kVQj9MMnoMixhRWoh.jpg",402],["Driving Miss Daisy",1989,2,1,"Bruce Beresford","Drama","iaCzvcY42HihFxQBTZCTKMpsI0P.jpg",403],["The Straight Story",1999,4.5,1,"David Lynch","Drama","tT9cMiVDdtlcdZxOoFy3VRmEoKk.jpg",404],["La Strada",1954,4,1,"Federico Fellini","Drama","rwjbT0zlsUDMztaCcWjlWuxaEL1.jpg",405],["La Haine",1995,3.5,1,"Mathieu Kassovitz","Drama","8rgPyWjYZhsphSSxbXguMnhN7H0.jpg",406],["Snow White and the Seven Dwarfs",1937,3,1,"David Hand","Fantasy, Animation, Family","3VAHfuNb6Z7UiW12iYKANSPBl8m.jpg",408],["The English Patient",1996,2.5,1,"Anthony Minghella","Drama, Romance, War","8eHHqMg8qEYtVw8LQLygsHXSR2q.jpg",409],["The Chronicles of Narnia: The Lion, the Witch and the Wardrobe",2005,3,1,"Andrew Adamson","Adventure, Family, Fantasy","iREd0rNCjYdf5Ar0vfaW32yrkm.jpg",411],["Batman Forever",1995,1.5,1,"Joel Schumacher","Action, Crime, Fantasy","i0fJS8M5UKoETjjJ0zwUiKaR8tr.jpg",414],["Batman & Robin",1997,1.5,1,"Joel Schumacher","Action, Science Fiction, Adventure","i7hEUpDuMN2LOrCEifFyGSHZQSY.jpg",415],["The Life Aquatic with Steve Zissou",2004,4.5,2,"Wes Anderson","Adventure, Comedy, Drama","qZoFLNBC78jzboWeDH6Ha0qavF2.jpg",421],["8½",1963,5,4,"Federico Fellini","Drama","t8pFvll3cFrn5NmqZz2FawqIwPe.jpg",422],["The Pianist",2002,4.5,1,"Roman Polanski","Drama, War","2hFvxCCWrTmCYwfy7yum0GKRi3Y.jpg",423],["Schindler's List",1993,5,1,"Steven Spielberg","Drama, History, War","sF1U4EUQS8YHUYjNl3pMGNIQyr0.jpg",424],["Ice Age",2002,3.5,3,"Chris Wedge","Animation, Comedy, Family, Adventure","gLhHHZUzeseRXShoDyC4VqLgsNv.jpg",425],["Vertigo",1958,5,3,"Alfred Hitchcock","Mystery, Romance, Thriller","15uOEfqBNTVtDUT7hGBVCka0rZz.jpg",426],["Mon Oncle",1958,3,1,"Jacques Tati","Comedy","wH6RyPiXFy8INLbViVkchLVOmBc.jpg",427],["The Good, the Bad and the Ugly",1966,5,4,"Sergio Leone","Western","bX2xnavhMYjWDoZp1VM6VnU1xwe.jpg",429],["Cube",1997,2.5,1,"Vincenzo Natali","Thriller, Science Fiction, Mystery","x4BTjxdrOKC27FcSkBh8KPEgnum.jpg",431],["Mary Poppins",1964,3,1,"Robert Stevenson","Comedy, Family, Fantasy","pHyWpWn2pRIfhS3Arcn4SKtKKW4.jpg",433],["The Day After Tomorrow",2004,2.5,1,"Roland Emmerich","Science Fiction, Thriller, Adventure","Wr4HeYQRvwVCxzOV5TmGE7UkXq.jpg",435],["Maria Full of Grace",2004,3.5,1,"Joshua Marston","Drama, Thriller, Crime","30CImATfvHWLXy6a3KmHXnYXB6c.jpg",436],["La Dolce Vita",1960,4,1,"Federico Fellini","Comedy, Drama","2KU52apQyvyZuPsqEGMcWb4BKu2.jpg",439],["Human Nature",2001,2,1,"Michel Gondry","Drama, Comedy","eyEgsPIwsr9bUV9n9INH46L5KuM.jpg",441],["Caché",2005,4.5,1,"Michael Haneke","Mystery, Drama, Thriller","vTzjRi0Uhy0tt3Rjw8SARZZJHlX.jpg",445],["The Idiots",1998,2.5,1,"Lars von Trier","Comedy, Drama","dZUgHe2XH8egBFerMC6yLoqUqii.jpg",452],["A Beautiful Mind",2001,3.5,1,"Ron Howard","Drama, Romance","rEIg5yJdNOt9fmX4P8gU9LeNoTQ.jpg",453],["Romeo + Juliet",1996,1.5,1,"Baz Luhrmann","Drama, Romance","eLf4jclPijOqfEp6bDAmezRFxk5.jpg",454],["Bend It Like Beckham",2002,3.5,1,"Gurinder Chadha","Comedy, Drama, Romance","2dzSBmFWWqt8NbnubJKIWU21Y86.jpg",455],["Erin Brockovich",2000,3,1,"Steven Soderbergh","Drama","jEMvWBWVjndZT0vJnLrRWi9ajea.jpg",462],["Klute",1971,3,1,"Alan J. Pakula","Thriller, Crime, Drama","tVyINAsNGSgD1OIstqwCcs7wyGH.jpg",466],["My Own Private Idaho",1991,3,1,"Gus Van Sant","Drama","p9TF90Pb5yg2MNb2UztzyXktMm4.jpg",468],["21 Grams",2003,3.5,1,"Alejandro G. Iñárritu","Drama, Crime, Thriller","wZ0l6or5juuVWqDkLEgaghs4f9l.jpg",470],["Pi",1998,3.5,1,"Darren Aronofsky","Mystery, Drama, Thriller","fJA22FjlAW8rzrOw9Mwanl6oTc9.jpg",473],["Bonnie and Clyde",1967,4,1,"Arthur Penn","Crime, Drama","sCSQFK9kMsprT4jgWqgw82dT6WI.jpg",475],["Drugstore Cowboy",1989,3.5,1,"Gus Van Sant","Drama, Crime","2bQXK39axyedUL6DE1pzdMYgAw1.jpg",476],["Wild at Heart",1990,3.5,1,"David Lynch","Crime, Thriller, Romance","uLUFI5sJIfWrBUWB2Y1dEuyvvVy.jpg",483],["The African Queen",1951,3.5,1,"John Huston","Romance, Adventure, Drama","2Ypg0KhQfFYWILelvHGtSHHR0dk.jpg",488],["Good Will Hunting",1997,4,1,"Gus Van Sant","Drama","z2FnLKpFi1HPO7BEJxdkv6hpJSU.jpg",489],["The Seventh Seal",1957,4,3,"Ingmar Bergman","Fantasy, Drama","wcZ21zrOsy0b52AfAF50XpTiv75.jpg",490],["Being John Malkovich",1999,4.5,1,"Spike Jonze","Comedy, Drama, Fantasy","vKVUsumbCzK5Kn3aDpKM4EizKCA.jpg",492],["Borat: Cultural Learnings of America for Make Benefit Glorious Nation of Kazakhstan",2006,4,1,"Larry Charles","Comedy","kfkyALfD4G1mlBJI1lOt2QCra4i.jpg",496],["The Green Mile",1999,4,1,"Frank Darabont","Fantasy, Drama, Crime","8VG8fDNiy50H4FedGwdSVUPoaJe.jpg",497],["Cléo from 5 to 7",1962,4,1,"Agnès Varda","Drama","oelBStY4xpguaplRv15P3Za7Xsr.jpg",499],["Reservoir Dogs",1992,4.5,2,"Quentin Tarantino","Crime, Thriller","xi8Iu6qyTfyZVDVy60raIOYJJmk.jpg",500],["Grizzly Man",2005,4.5,1,"Werner Herzog","Documentary","zuZWpcuye25rpsiZ4XzsAvmLDHG.jpg",501],["Fail Safe",1964,4.5,1,"Sidney Lumet","Thriller, Drama, War","qrsj5hort5xkLOKw9NyraGMnlVP.jpg",502],["Poseidon",2006,2,1,"Wolfgang Petersen","Adventure, Action, Drama, Thriller","fDPdjGc8SUEDWfTwMaZlCE6NSi3.jpg",503],["Monster",2003,3,1,"Patty Jenkins","Crime, Drama","b45yfHtLk4TSSDxOLgMLBpShner.jpg",504],["Marnie",1964,3,1,"Alfred Hitchcock","Thriller, Mystery, Romance","nRRy4VO2A3Py7wiZBPz11PAlogp.jpg",506],["Love Actually",2003,2,1,"Richard Curtis","Comedy, Romance, Drama","7QPeVsr9rcFU9Gl90yg0gTOTpVv.jpg",508],["Notting Hill",1999,3.5,1,"Roger Michell","Romance, Comedy","hHRIf2XHeQMbyRb3HUx19SF5Ujw.jpg",509],["One Flew Over the Cuckoo's Nest",1975,5,4,"Miloš Forman","Drama","kjWsMh72V6d8KRLV4EOoSJLT1H7.jpg",510],["Scoop",2006,3.5,1,"Woody Allen","Comedy, Mystery","1nF290EoEn2rs4W9VVercKa4S5o.jpg",512],["Dial M for Murder",1954,4,1,"Alfred Hitchcock","Thriller, Crime, Drama","4KKiFDvtEusJzqzlwHp7iMceXKS.jpg",521],["Ed Wood",1994,4.5,2,"Tim Burton","Comedy, Drama, History","jNao464ZTwWUWr3uJJ8swVgaKd9.jpg",522],["Casino",1995,4.5,3,"Martin Scorsese","Crime, Drama","gziIkUSnYuj9ChCi8qOu2ZunpSC.jpg",524],["The Blues Brothers",1980,3.5,1,"John Landis","Music, Comedy, Crime","rhYJKOt6UrQq7JQgLyQcSWW5R86.jpg",525],["Once Were Warriors",1994,3,1,"Lee Tamahori","Drama","1nd4SsytVc96hy92g8NNVPD3mzf.jpg",527],["A Grand Day Out",1989,3,1,"Nick Park","Family, Animation, Comedy, Science Fiction, Adventure","h5e3r12VwfUotN36fBr1DNeCD4n.jpg",530],["The Wrong Trousers",1993,4.5,1,"Nick Park","Animation, Comedy, Family","mV8SDTjkxrDxu0a0egvFz1lRPU7.jpg",531],["A Close Shave",1995,3.5,1,"Nick Park","Family, Animation, Comedy","qdIR27trLyrlJ5nmkbcG3Bomah6.jpg",532],["Wallace & Gromit: The Curse of the Were-Rabbit",2005,4,1,"Nick Park","Adventure, Animation, Comedy, Family","cMQ2lNd7sBe6PCf6zF5QxrKzbRG.jpg",533],["Terminator Salvation",2009,2.5,1,"McG","Action, Science Fiction, Thriller","gw6JhlekZgtKUFlDTezq3j5JEPK.jpg",534],["Flashdance",1983,3,1,"Adrian Lyne","Drama, Romance","ziiy6ORt8BlxWFXskBChBMInvDA.jpg",535],["Psycho",1960,4.5,3,"Alfred Hitchcock","Horror, Thriller, Mystery","yz4QVqPx3h1hD1DfqqQkCq3rmxW.jpg",539],["There's Something About Mary",1998,3.5,1,"Peter Farrelly & Bobby Farrelly","Romance, Comedy","slJD1Dvnsf15LoeqhERsyzisAdn.jpg",544],["Rashomon",1950,4.5,1,"Akira Kurosawa","Crime, Drama, Mystery","vL7Xw04nFMHwnvXRFCmYYAzMUvY.jpg",548],["Fight Club",1999,4.5,2,"David Fincher","Drama, Thriller","pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",550],["Dogville",2003,4.5,1,"Lars von Trier","Crime, Drama, Thriller","lraVawavIXh5geMlVjpzCw9TGwR.jpg",553],["Spider-Man",2002,4,3,"Sam Raimi","Action, Science Fiction","kjdJntyBeEvqm9w97QGBdxPptzj.jpg",557],["Spider-Man 2",2004,4.5,4,"Sam Raimi","Action, Adventure, Science Fiction","eg8XHjA7jkM3ulBLnfGTczR9ytI.jpg",558],["Spider-Man 3",2007,2.5,3,"Sam Raimi","Action, Adventure, Science Fiction","qFmwhVUoUSXjkKRmca5yGDEXBIj.jpg",559],["Constantine",2005,2,1,"Francis Lawrence","Fantasy, Action, Horror","vPYgvd2MwHlxTamAOjwVQp4qs1W.jpg",561],["Die Hard",1988,4,2,"John McTiernan","Action, Thriller","7Bjd8kfmDSOzpmhySpEhkUyK2oH.jpg",562],["Starship Troopers",1997,3,1,"Paul Verhoeven","Adventure, Action, Thriller, Science Fiction","cxCmv23O7p3hyHwqoktHYkZcGsY.jpg",563],["The Mummy",1999,4,4,"Stephen Sommers","Action, Adventure, Fantasy","yhIsVvcUm7QxzLfT6HW2wLf5ajY.jpg",564],["The Ring",2002,2.5,1,"Gore Verbinski","Horror, Mystery","e2t5CKMox7tjv3iD3Ko7NdFa5lJ.jpg",565],["Rear Window",1954,5,4,"Alfred Hitchcock","Thriller, Mystery, Drama","ILVF0eJxHMddjxeQhswFtpMtqx.jpg",567],["Apollo 13",1995,3,1,"Ron Howard","Drama, History","tVeKscCm2fY1xDXZk8PgnZ87h9S.jpg",568],["The Birds",1963,4,1,"Alfred Hitchcock","Horror, Thriller","eClg8QPg8mwB6INIC4pyR5pAbDr.jpg",571],["Frenzy",1972,4,1,"Alfred Hitchcock","Crime, Thriller, Horror","4SFvqrlSigAt9tnhXFSMyKeJWQk.jpg",573],["The Man Who Knew Too Much (1956)",1956,3.5,1,"Alfred Hitchcock","Thriller, Mystery, Drama","gy8YBRjCQRIT9x9G9F5fpnFD4xw.jpg",574],["The Wild Bunch",1969,3.5,1,"Sam Peckinpah","Western","8j9yEC3xjy1PJDSizIbaxcHaSph.jpg",576],["To Die For",1995,3.5,1,"Gus Van Sant","Drama, Comedy, Crime","whz4bwvqE1OmQHIyqHdZD8jU9CO.jpg",577],["Jaws",1975,4.5,2,"Steven Spielberg","Horror, Thriller, Adventure","tjbLSFwi0I3phZwh8zoHWNfbsEp.jpg",578],["Jaws 2",1978,2.5,1,"Jeannot Szwarc","Horror, Thriller","cN3ijEwsn4kBaRuHfcJpAQJbeWe.jpg",579],["Jaws: The Revenge",1987,0.5,1,"Joseph Sargent","Adventure, Thriller, Horror","ebYw9tR0iqBzDGA6HVBhtd2xJM3.jpg",580],["Dances with Wolves",1990,3,1,"Kevin Costner","Adventure, Drama, Western","hw0ZEHAaTqTxSXGVwUFX7uvanSA.jpg",581],["The Lives of Others",2006,4.5,1,"Florian Henckel von Donnersmarck","Drama, Thriller","cVUDMnskSc01rdbyH0tLATTJUdP.jpg",582],["Life of Brian",1979,4.5,5,"Terry Jones","Comedy","lSSA64WF0M0BXnjwr2quMh6shCl.jpg",583],["2 Fast 2 Furious",2003,2,1,"John Singleton","Action, Crime, Thriller","6nDZExrDKIXvSAghsFKVFRVJuSf.jpg",584],["Monsters, Inc.",2001,4,3,"Pete Docter","Animation, Comedy, Family, Fantasy","wFSpyMsp7H0ttERbxY7Trlv8xry.jpg",585],["Wag the Dog",1997,3.5,1,"Barry Levinson","Comedy, Drama","pKl49ecMnCMX5XK5LUdxulxHLNi.jpg",586],["Big Fish",2003,4,1,"Tim Burton","Adventure, Fantasy, Drama","tjK063yCgaBAluVU72rZ6PKPH2l.jpg",587],["The Hours",2002,4,1,"Stephen Daldry","Drama","4myDtowDJQPQnkEDB1IWGtJR1Fo.jpg",590],["The Da Vinci Code",2006,2,1,"Ron Howard","Thriller, Mystery","9ejKfNk0LBhSI9AahH4f9NJNZNM.jpg",591],["The Conversation",1974,4,1,"Francis Ford Coppola","Crime, Drama, Mystery","dHqVBwcv1SGymOpUueRoKzcmdes.jpg",592],["Solaris",1972,4.5,1,"Andrei Tarkovsky","Drama, Science Fiction, Mystery","pgqj7QoBPWFLLKtLEpPmFYFRMgB.jpg",593],["The Terminal",2004,3,1,"Steven Spielberg","Comedy, Drama","cPB3ZMM4UdsSAhNdS4c7ps5nypY.jpg",594],["To Kill a Mockingbird",1962,4.5,1,"Robert Mulligan","Drama","oe88ZKHH1g0HWl7oReFpHTIryiJ.jpg",595],["The Grapes of Wrath",1940,4.5,1,"John Ford","Drama","eUcxMVBIA0Jg8l1RGUqycrc3eIQ.jpg",596],["Titanic",1997,3.5,2,"James Cameron","Drama, Romance","9xjZS2rlVxm8SFx8kPC3aIGCOYQ.jpg",597],["City of God",2002,5,2,"Fernando Meirelles","Drama, Crime","k7eYdWvhYQyRQoU2TB2A2Xu2TfD.jpg",598],["Sunset Boulevard",1950,4.5,1,"Billy Wilder","Drama","zt8aQ6ksqK6p1AopC5zVTDS9pKT.jpg",599],["Full Metal Jacket",1987,4,3,"Stanley Kubrick","Drama, War","kMKyx1k8hWWscYFnPbnxxN4Eqo4.jpg",600],["E.T. the Extra-Terrestrial",1982,4,1,"Steven Spielberg","Adventure, Science Fiction, Family","an0nD6uq6byfxXCfk6lQBzdL2J1.jpg",601],["Independence Day",1996,3,1,"Roland Emmerich","Action, Adventure, Science Fiction","p0BPQGSPoSa8Ml0DAf2mB2kCU0R.jpg",602],["The Matrix",1999,4.5,2,"Lilly & Lana Wachowski","Action, Science Fiction","p96dm7sCMn4VYAStA6siNz30G1r.jpg",603],["The Matrix Reloaded",2003,3,1,"Lilly & Lana Wachowski","Adventure, Action, Thriller, Science Fiction","aA5qHS0FbSXO8PxcxUIHbDrJyuh.jpg",604],["The Matrix Revolutions",2003,2,1,"Lilly & Lana Wachowski","Adventure, Action, Thriller, Science Fiction","bkkS61w94ZVMNVd8KEyyJl2tnY5.jpg",605],["Men in Black",1997,4,1,"Barry Sonnenfeld","Science Fiction, Comedy, Action, Adventure","uLOmOF5IzWoyrgIF5MfUnh5pa1X.jpg",607],["Men in Black II",2002,2.5,1,"Barry Sonnenfeld","Action, Comedy, Science Fiction","enA22EPyzc2WQ1VVyY7zxresQQr.jpg",608],["Poltergeist",1982,3,1,"Tobe Hooper","Horror","m5AKo8iZAYulI87Uzxkn87vRY07.jpg",609],["Munich",2005,3.5,1,"Steven Spielberg","Drama, History, Thriller","iUekaw96QLInZpsNwRTlRKrZgwm.jpg",612],["Downfall",2004,3.5,1,"Oliver Hirschbiegel","Drama, History, War","cP1ElGjBhbZAAqmueXjHDKlSwiP.jpg",613],["Wild Strawberries",1957,4,1,"Ingmar Bergman","Drama","iyTD2QnySNMPUPE3IedZQipSWfz.jpg",614],["The Passion of the Christ",2004,3,1,"Mel Gibson","Drama","v9f9MMrq2nGQrN7cHnQRmEq9lSE.jpg",615],["The Last Samurai",2003,3,1,"Edward Zwick","Drama, Action, War","a8jmJPs5eZBARmnuEEvZwbjwyz4.jpg",616],["The Birth of a Nation",1915,2,1,"D.W. Griffith","Drama, History, War","pNpOXpQI5GSUfiWypubYtMh9928.jpg",618],["Ghostbusters",1984,4,1,"Ivan Reitman","Comedy, Fantasy","7E8nLijS9AwwUEPu2oFYOVKhdFA.jpg",620],["Grease",1978,3,1,"Randal Kleiser","Romance, Comedy","2rM7fQKpb7cs1Iq7IBqub9LFDzJ.jpg",621],["A Fish Called Wanda",1988,3.5,1,"Charles Crichton","Comedy, Crime","hkSGFNVfEEUXFCxRZDITFHVhUlu.jpg",623],["Easy Rider",1969,3,1,"Dennis Hopper","Adventure, Drama","mmGEB6ly9OG8SYVfvAoa6QqHNvN.jpg",624],["Un Chien Andalou",1929,4,1,"Luis Buñuel","Fantasy","obvE7ElAvCUhKtWFwDSvNbPw9PV.jpg",626],["Trainspotting",1996,4.5,1,"Danny Boyle","Drama, Crime","y0HmDV0bZDTtXWHqqYYbT9XoshB.jpg",627],["Interview with the Vampire",1994,3.5,1,"Neil Jordan","Horror, Drama, Fantasy","2162lAT2MP36MyJd2sttmj5du5T.jpg",628],["The Usual Suspects",1995,3.5,1,"Bryan Singer","Drama, Crime, Thriller","99X2SgyFunJFXGAYnDv3sb9pnUD.jpg",629],["The Wizard of Oz",1939,3.5,2,"Victor Fleming","Adventure, Family, Fantasy","lbezZTzzOcomu2ezKJBUsIPtqA6.jpg",630],["Sunrise: A Song of Two Humans",1927,3.5,1,"F. W. Murnau","Drama, Romance","oj8ZW8jKXBSs8F1e5iWsTUeXSJW.jpg",631],["Stalag 17",1953,3.5,1,"Billy Wilder","Comedy, Drama, War","lfve9FDKjT7JPbWI9NCs5340F79.jpg",632],["Bridget Jones's Diary",2001,2.5,1,"Sharon Maguire","Comedy, Romance, Drama","olMTi7uCaec9Yr3Ar07D2SIja1G.jpg",634],["Angel Heart",1987,3,1,"Alan Parker","Horror, Mystery","h5v3wjJQNB7q2RntEnKDLhKtTFE.jpg",635],["THX 1138",1971,2.5,1,"George Lucas","Science Fiction, Drama","25cQH5gZ60BiA5Y91HxoPpnFiY0.jpg",636],["Life Is Beautiful",1997,4.5,2,"Roberto Benigni","Comedy, Drama","mfnkSeeVOBVheuyn2lo4tfmOPQb.jpg",637],["Lost Highway",1997,4,1,"David Lynch","Drama, Thriller, Mystery","fdTtij6H0sX9AzIjUeynh5zbfm7.jpg",638],["When Harry Met Sally...",1989,4.5,2,"Rob Reiner","Comedy, Romance, Drama","rFOiFUhTMtDetqCGClC9PIgnC1P.jpg",639],["Catch Me If You Can",2002,4,1,"Steven Spielberg","Drama, Crime","ctjEj2xM32OvBXCq8zAdK3ZrsAj.jpg",640],["Requiem for a Dream",2000,4.5,1,"Darren Aronofsky","Crime, Drama","nOd6vjEmzCT0k4VYqsA2hwyi87C.jpg",641],["Butch Cassidy and the Sundance Kid",1969,5,2,"George Roy Hill","Western","gFmmykF1Ym3OGzENo50nZQaD1dx.jpg",642],["Battleship Potemkin",1925,4,1,"Sergei Eisenstein","Drama, History, War","hZmsRLsCnE9Zshf1YJONUpCOhds.jpg",643],["A.I. Artificial Intelligence",2001,3.5,1,"Steven Spielberg","Drama, Science Fiction, Adventure","8MZSGX5JORoO72EfuAEcejH5yHn.jpg",644],["Dr. No",1962,2.5,1,"Terence Young","Action, Thriller, Adventure","f9HsemSsBEHN5eoMble1bj6fDxs.jpg",646],["Belle de Jour",1967,4,1,"Luis Buñuel","Drama, Romance","iUAFECovwPA0cVV9bo4uNGLJSGL.jpg",649],["Boyz n the Hood",1991,4,1,"John Singleton","Crime, Drama","v4ox4aSCNT5vyLXl4Q71JiWwCXW.jpg",650],["M*A*S*H",1970,2.5,1,"Robert Altman","Comedy, Drama, War","on8Q9LhtHYNhmITjUMpgOUkIG8o.jpg",651],["Troy",2004,3,1,"Wolfgang Petersen","War, Action, History","a07wLy4ONfpsjnBqMwhlWTJTcm.jpg",652],["Nosferatu",1922,3.5,1,"F. W. Murnau","Horror, Fantasy","zv7J85D8CC9qYagAEhPM63CIG6j.jpg",653],["On the Waterfront",1954,4.5,1,"Elia Kazan","Crime, Drama, Romance","fKjLZy9W8VxMOp5OoyWojmLVCQw.jpg",654],["Paris, Texas",1984,4.5,1,"Wim Wenders","Drama","sP27Qm4THyRZyHjHYMfIDtJP6YE.jpg",655],["From Russia with Love",1963,3,1,"Terence Young","Action, Thriller, Adventure","zx4V17FP8oclNvOpTgs2iCCtiYk.jpg",657],["Goldfinger",1964,3.5,1,"Guy Hamilton","Adventure, Action, Thriller","aKNFzaqQgPzsGXnsMc4kJH5hFIV.jpg",658],["The Tin Drum",1979,2.5,1,"Volker Schlöndorff","Drama, History, War","z4QsBWJbbBxct2zU7LnYSOw8UFz.jpg",659],["Thunderball",1965,2,1,"Terence Young","Adventure, Action, Thriller","wCc4qllaTDsQN8zgGkAgQrKO6N9.jpg",660],["La Jetée",1962,4.5,2,"Chris Marker","Drama, Romance, Science Fiction","elGidsRHXkk8UyrtLbcMhaptDyp.jpg",662],["Saw IV",2007,1.5,1,"Darren Lynn Bousman","Horror, Thriller, Crime","ku1QdCXOU4ckz3zxLLlis8MIJVm.jpg",663],["Twister",1996,2.5,1,"Jan de Bont","Action, Adventure, Drama","d4ie3f6QTvNw40V770Uzo87SDZn.jpg",664],["Ben-Hur",1959,2.5,1,"William Wyler","History, Drama, Adventure","m4WQ1dBIrEIHZNCoAjdpxwSKWyH.jpg",665],["Central Station",1998,3.5,1,"Walter Salles","Drama","zJvp7XjQ2LhPbDVYhFXyucs40vR.jpg",666],["You Only Live Twice",1967,3,1,"Lewis Gilbert","Action, Thriller, Adventure","fdRbvRcEXcf2rC4ghLFZzCWPSmB.jpg",667],["On Her Majesty's Secret Service",1969,4,1,"Peter R. Hunt","Adventure, Action, Thriller","m3KfbxvqaiAvRJ6MpguA3GuLdDQ.jpg",668],["Nanook of the North",1922,3,1,"Robert Flaherty","Documentary, Drama","9WAboi1QbKu41WkyGxQVNpXwwxx.jpg",669],["Oldboy",2003,4,2,"Park Chan-wook","Thriller, Mystery","pWDtjs568ZfOTMbURQBYuT4Qxka.jpg",670],["Harry Potter and the Philosopher's Stone",2001,3,1,"Chris Columbus","Adventure, Fantasy","wuMc08IPKEatf9rnMNXvIDxqP4W.jpg",671],["Harry Potter and the Chamber of Secrets",2002,3,2,"Chris Columbus","Adventure, Fantasy","sdEOH0992YZ0QSxgXNIGLq1ToUi.jpg",672],["Harry Potter and the Prisoner of Azkaban",2004,3.5,2,"Alfonso Cuarón","Adventure, Fantasy","aWxwnYoe8p2d2fcxOqtvAtJ72Rw.jpg",673],["Harry Potter and the Goblet of Fire",2005,3.5,2,"Mike Newell","Adventure, Fantasy","fECBtHlr0RB3foNHDiCBXeg9Bv9.jpg",674],["Harry Potter and the Order of the Phoenix",2007,2.5,1,"David Yates","Adventure, Fantasy","5aOyriWkPec0zUDxmHFP9qMmBaj.jpg",675],["Pearl Harbor",2001,1.5,1,"Michael Bay","War, History, Drama","y8A0Cvp8WQmZ3bjbnsL53lY0dsC.jpg",676],["Out of the Past",1947,3.5,1,"Jacques Tourneur","Crime, Thriller","lnUK6Cg5ARM0qaq0B5SG20VAM0h.jpg",678],["Aliens",1986,4,1,"James Cameron","Action, Thriller, Science Fiction","r1x5JGpyqZU8PYhbs4UcrO1Xb6x.jpg",679],["Pulp Fiction",1994,5,3,"Quentin Tarantino","Comedy, Thriller, Crime","vQWk5YBFWF4bZaofAbv0tShwBvQ.jpg",680],["Diamonds Are Forever",1971,2,1,"Guy Hamilton","Action, Thriller","ooDT0eKrWCxJCsn9JehPkD0QYNj.jpg",681],["The Man with the Golden Gun",1974,2.5,1,"Guy Hamilton","Adventure, Action, Thriller","xVkbKwGnBVNQ122GN5bCTMyPbWz.jpg",682],["Contact",1997,3,1,"Robert Zemeckis","Drama, Science Fiction, Mystery","bCpMIywuNZeWt3i5UMLEIc0VSwM.jpg",686],["Dead Man Walking",1995,4,1,"Tim Robbins","Drama","eShxyjhWoFl3BwsuEmVsr4nLaMZ.jpg",687],["The Bridges of Madison County",1995,4,1,"Clint Eastwood","Drama, Romance","teGMLWvCnJqvtPYCSuUKRM9MvFe.jpg",688],["Pickpocket",1959,2.5,1,"Robert Bresson","Crime, Drama","kxpvceDv9fhFc4OAs82fmdzu17Y.jpg",690],["The Spy Who Loved Me",1977,3.5,1,"Lewis Gilbert","Adventure, Action, Thriller","cOm2ULaB4luYEjxlI53tW6jWLyJ.jpg",691],["Pink Flamingos",1972,3.5,1,"John Waters","Comedy, Crime","10N8SvTQwUqyWgocPam1P18Jgr.jpg",692],["Meet the Fockers",2004,2.5,1,"Jay Roach","Comedy, Romance","59fXm6N2x7QSbvt6BaBxTNBXGL8.jpg",693],["The Shining",1980,5,3,"Stanley Kubrick","Horror, Thriller","uAR0AWqhQL1hQa69UDEbb2rE5Wx.jpg",694],["Short Cuts",1993,4.5,1,"Robert Altman","Drama, Comedy","nAEBc3g9bHAcF9whKFMfIxHxVwn.jpg",695],["Manhattan",1979,4.5,1,"Woody Allen","Comedy, Drama, Romance","k4eT3EvfxW1L9Wmt04UqJqCvCR6.jpg",696],["October (Ten Days that Shook the World)",1928,3.5,1,"Sergei Eisenstein","Drama, History","2sNZPybGgux2keFKxZuKuedrS3d.jpg",697],["Moonraker",1979,2.5,1,"Lewis Gilbert","Action, Adventure, Thriller, Science Fiction","6LrJdXNmu5uHOVALZxVYd44Lva0.jpg",698],["For Your Eyes Only",1981,2.5,1,"John Glen","Adventure, Action, Thriller","xV4Nnr6DjjERlqNikqDQX8LUgua.jpg",699],["Octopussy",1983,3,1,"John Glen","Adventure, Action, Thriller","yoosZitM9igSk3Sd0sBXIhKlAh1.jpg",700],["Our Hospitality",1923,3,1,"Buster Keaton","Comedy, Romance, Thriller","cAEdL6RzfDSbPO51izl01Njzikx.jpg",701],["A Streetcar Named Desire",1951,4.5,1,"Elia Kazan","Drama, Thriller","aicdlO5vt7z2ARm279eGzJeYCLQ.jpg",702],["Annie Hall",1977,4.5,1,"Woody Allen","Comedy, Drama, Romance","gBo4G0p8iVS998aYvXS656jbsH2.jpg",703],["A Hard Day's Night",1964,3.5,1,"Richard Lester","Comedy, Music","6Ulsccp2VkaVU5qbya3bxm9JG4x.jpg",704],["All About Eve",1950,4.5,1,"Joseph L. Mankiewicz","Drama","blBzZaatPWVuWpXEnPscMA4Xp6m.jpg",705],["A View to a Kill",1985,2,1,"John Glen","Adventure, Action, Thriller","arJF829RP9cYvh0NU70dC5TtXSa.jpg",707],["The Living Daylights",1987,3,1,"John Glen","Action, Adventure, Thriller","1oRlmWX9hewpn2B44wawBjHd7dx.jpg",708],["Licence to Kill",1989,3.5,1,"John Glen","Adventure, Action, Thriller","8nzJve63EXA79HGAyidZwivZrQ2.jpg",709],["GoldenEye",1995,3.5,1,"Martin Campbell","Adventure, Action, Thriller","z0ljRnNxIO7CRBhLEO0DvLgAFPR.jpg",710],["Four Weddings and a Funeral",1994,3.5,1,"Mike Newell","Comedy, Drama, Romance","qa72G2VS0bpxms6yo0tI9vsHm2e.jpg",712],["The Piano",1993,4,2,"Jane Campion","Drama, Romance","dUxjG6baSzGIgP7R8BQI5rpMuET.jpg",713],["Tomorrow Never Dies",1997,2.5,1,"Roger Spottiswoode","Adventure, Action, Thriller","gZm002w7q9yLOkltxT76TWGfdZX.jpg",714],["Top Gun",1986,2.5,1,"Tony Scott","Action, Drama, Romance","xUuHj3CgmZQ9P2cMaqQs4J0d4Zc.jpg",744],["The Sixth Sense",1999,4,1,"M. Night Shyamalan","Mystery, Thriller, Drama","vOyfUXNFSnaTk7Vk5AjpsKTUWsu.jpg",745],["The Last Emperor",1987,3,1,"Bernardo Bertolucci","Drama, History","7TILJhdeJAaEyDiwvJZMo9SQBoe.jpg",746],["Shaun of the Dead",2004,4.5,3,"Edgar Wright","Horror, Comedy","dgXPhzNJH8HFTBjXPB177yNx6RI.jpg",747],["V for Vendetta",2005,3.5,2,"James McTeigue","Action, Thriller, Science Fiction","1avD1JeaRiJX5M4ahPdZPypGoGN.jpg",752],["Face/Off",1997,4,1,"John Woo","Action, Crime, Science Fiction","69Xzn8UdPbVnmqSChKz2RTpoNfB.jpg",754],["From Dusk Till Dawn",1996,3.5,1,"Robert Rodriguez","Horror, Action, Crime","sV3kIAmvJ9tPz4Lq5fuf9LLMxte.jpg",755],["Fantasia",1940,4,1,"Ben Sharpsteen","Animation, Family, Fantasy","5m9njnidjR0syG2gpVPVgcEMB2X.jpg",756],["Gentlemen Prefer Blondes",1953,3,1,"Howard Hawks","Comedy, Romance","fDozhst5HVJJcd3BM8ZOsKniO7Q.jpg",759],["Monty Python and the Holy Grail",1975,4,3,"Terry Jones","Adventure, Comedy, Fantasy","7nTkHjETdGMYK1phHwDbPsrzbYl.jpg",762],["Braindead",1992,4.5,1,"Peter Jackson","Horror, Comedy","pa39D8TQs6aNw3hiUs4jLjHVUB0.jpg",763],["The Evil Dead",1981,4,2,"Sam Raimi","Horror","54C1qdaiSijIU5NeNb4WsPJdNkG.jpg",764],["Evil Dead II",1987,4.5,2,"Sam Raimi","Horror, Comedy, Fantasy","4zqCKJVHUolGs6C5AZwAZqLWixW.jpg",765],["Army of Darkness",1992,3,1,"Sam Raimi","Fantasy, Horror, Comedy","xsgTuAtR2zSH8Umg3jWZcZjlDpe.jpg",766],["Harry Potter and the Half-Blood Prince",2009,2,1,"David Yates","Adventure, Fantasy","z7uo9zmQdQwU5ZJHFpv2Upl30i1.jpg",767],["GoodFellas",1990,5,8,"Martin Scorsese","Drama, Crime","9OkCLM73MIU2CrKZbqiT8Ln1wY2.jpg",769],["Gone with the Wind",1939,4,1,"Victor Fleming","Drama, War, Romance","lNz2Ow0wGCAvzckW7EOjE03KcYv.jpg",770],["Home Alone",1990,3.5,4,"Chris Columbus","Comedy, Family","i5We88HdO9Nsrv8xLyo4toNsLUM.jpg",771],["Home Alone 2: Lost in New York",1992,3,2,"Chris Columbus","Comedy, Family, Adventure","9CAkQ9nfrDaIAyncWndwg0tfC8g.jpg",772],["Little Miss Sunshine",2006,4.5,2,"Jonathan Dayton & Valerie Faris","Comedy, Drama","niNdhTpPHSgw22tK0PLjQMV640v.jpg",773],["Workers Leaving the Lumière Factory",1895,2.5,1,"Louis Lumière","History, Documentary","cT2sefAXgEoICJUCEM6UfxXfuDM.jpg",774],["A Trip to the Moon",1902,4,1,"Georges Méliès","Adventure, Science Fiction, Comedy","9o0v5LLFk51nyTBHZSre6OB37n2.jpg",775],["The Rules of the Game",1939,3.5,1,"Jean Renoir","Drama, Comedy, Romance","8JOzt7uFZyshcuzCBmYU6CDJL4D.jpg",776],["Grand Illusion",1937,4,1,"Jean Renoir","Drama, History, War","lWg41zE0FVixkNsFgxnlRyvDYv9.jpg",777],["Monsieur Hulot's Holiday",1953,2.5,1,"Jacques Tati","Comedy","r4F4tsU0Ajeh9ZYUkWOJSYmioj7.jpg",778],["Vampyr",1932,3.5,1,"Carl Theodor Dreyer","Horror, Fantasy, Mystery","yt3JS5JSoZseSohYkhs6FLU9B0O.jpg",779],["The Passion of Joan of Arc",1928,5,2,"Carl Theodor Dreyer","Drama, History","tAgV9yxY6AC1bsPt3qJJQpD4s8.jpg",780],["Gattaca",1997,3.5,1,"Andrew Niccol","Science Fiction, Drama","eSKr5Fl1MEC7zpAXaLWBWSBjgJq.jpg",782],["Gandhi",1982,3,1,"Richard Attenborough","Drama, History","rOXftt7SluxskrFrvU7qFJa5zeN.jpg",783],["Almost Famous",2000,4.5,2,"Cameron Crowe","Drama, Music","3rrkyLYbgLj84AYvjhdcJot4JPx.jpg",786],["Mr. & Mrs. Smith",2005,2.5,1,"Doug Liman","Action, Comedy, Drama, Thriller","kjD700RtyhveN3ZbOnSvUSne0Qj.jpg",787],["Mrs. Doubtfire",1993,2.5,1,"Chris Columbus","Comedy, Drama, Family","shHrSmXS5140o6sQzgzXxn3KqSm.jpg",788],["The Fog",1980,3.5,1,"John Carpenter","Horror","12EeSboRofP3CI4SPmMFNNXCbtY.jpg",790],["Platoon",1986,4.5,1,"Oliver Stone","Drama, War, Action","m3mmFkPQKvPZq5exmh0bDuXlD9T.jpg",792],["Blue Velvet",1986,4.5,1,"David Lynch","Mystery, Thriller, Crime","tzXuURjPzCqtA6eL0Cswq9wzFx0.jpg",793],["The Omen",1976,4,1,"Richard Donner","Horror, Thriller","mDcjjEu1fMNmsXi4l4D8IftlTix.jpg",794],["Cruel Intentions",1999,2,1,"Roger Kumble","Drama, Romance","76cCsRtQ5MJBAqoigojXsLXLJwh.jpg",796],["Persona",1966,5,5,"Ingmar Bergman","Drama","v2KsLNChpT6vLf0YFhkJmAtGkNq.jpg",797],["The Young and the Damned",1950,3.5,1,"Luis Buñuel","Drama, Crime","cDCvmYoyqFg4CuSMtGMvCpfOIEw.jpg",800],["Good Morning, Vietnam",1987,2.5,1,"Barry Levinson","Comedy, Drama, War","sreISlFUn5TyR41QNjlfAdX5SEW.jpg",801],["Lolita",1962,3.5,1,"Stanley Kubrick","Drama","8Puqbeh0D95DpXFWep1rmH78btu.jpg",802],["Night and Fog",1956,4,1,"Alain Resnais","Documentary, History","2iWYQia8enOai7QEO3TvenleD7r.jpg",803],["Roman Holiday",1953,4.5,1,"William Wyler","Romance, Comedy, Drama","8lI9dmz1RH20FAqltkGelY1v4BE.jpg",804],["Rosemary's Baby",1968,4.5,1,"Roman Polanski","Drama, Horror, Thriller","uYgvlHceRFjAFbsNeMInYcLZLUb.jpg",805],["Se7en",1995,5,2,"David Fincher","Crime, Mystery, Thriller","191nKfP0ehp3uIvWqgPbFmI4lv9.jpg",807],["Shrek",2001,4.5,14,"Andrew Adamson","Animation, Comedy, Fantasy, Adventure, Family","iB64vpL3dIObOtMZgX3RqdVdQDc.jpg",808],["Shrek 2",2004,5,12,"Andrew Adamson","Animation, Comedy, Family, Fantasy, Romance","2yYP0PQjG8zVqturh1BAqu2Tixl.jpg",809],["Shrek the Third",2007,3,5,"Chris Miller","Fantasy, Adventure, Animation, Comedy, Family","n4SexGGQzI26E269tfpa80MZaGV.jpg",810],["Aladdin",1992,4,1,"John Musker & Ron Clements","Animation, Family, Adventure, Fantasy, Romance","eLFfl7vS8dkeG1hKp5mwbm37V83.jpg",812],["Airplane!",1980,4,3,"Jerry Zucker & David Zucker & Jim Abrahams","Comedy","7Q3efxd3AF1vQjlSxnlerSA7RzN.jpg",813],["An American Werewolf in London",1981,3.5,1,"John Landis","Comedy, Horror, Fantasy","hVEqUASJmCQaolkKFEySCHZ8uKG.jpg",814],["Austin Powers: International Man of Mystery",1997,2.5,1,"Jay Roach","Comedy, Crime","5uD4dxNX8JKFjWKYMHyOsqhi5pN.jpg",816],["Austin Powers: The Spy Who Shagged Me",1999,3,3,"Jay Roach","Comedy, Adventure, Crime","jiF7UShERJFn5RtgfBK2lIJrOTc.jpg",817],["Austin Powers in Goldmember",2002,2.5,1,"Jay Roach","Comedy, Crime","n8V61f1v7idya4WJzGEJNoIp9iL.jpg",818],["Sleepers",1996,2.5,1,"Barry Levinson","Crime, Drama, Thriller","yUpiEk2EojS9ZEXb3nIQonQCYYF.jpg",819],["JFK",1991,4.5,1,"Oliver Stone","Drama, Thriller, History","r0VWVTYlqdRCK5ZoOdNnHdqM2gt.jpg",820],["Judgment at Nuremberg",1961,4.5,1,"Stanley Kramer","Drama, History","b6vYatvui1EXeFYfpDX4rcbueuP.jpg",821],["Moulin Rouge!",2001,2,1,"Baz Luhrmann","Drama, Romance, Music","2kjM5CUZRIU5yOANUowrbJcRL9L.jpg",824],["The Bridge on the River Kwai",1957,4.5,1,"David Lean","Drama, History, War","7paXMt2e3Tr5dLmEZOGgFEn2Vo7.jpg",826],["Diabolique",1955,4,1,"Henri-Georges Clouzot","Thriller, Mystery","jE8ygUYBUGyUcM4sR6iinPqYeDK.jpg",827],["The Day the Earth Stood Still",1951,3,1,"Robert Wise","Science Fiction, Thriller, Drama","eslDNzf0LF1m9GsgUXlmyfTcC6Y.jpg",828],["Chinatown",1974,5,1,"Roman Polanski","Crime, Mystery, Thriller","kZRSP3FmOcq0xnBulqpUQngJUXY.jpg",829],["Forbidden Planet",1956,2.5,1,"Fred M. Wilcox","Science Fiction, Adventure","aq0OQfRS7hDDI8vyD0ICbH9eguC.jpg",830],["M",1931,5,1,"Fritz Lang","Drama, Thriller, Crime","bTdZk3q2DWpBRnLiaaItKFWOVhI.jpg",832],["Umberto D.",1952,4,1,"Vittorio De Sica","Drama","5I7SYsNQmZRZpQ2MAarIQYU9vaX.jpg",833],["Videodrome",1983,4,1,"David Cronenberg","Horror, Science Fiction, Mystery","qqqkiZSU9EBGZ1KiDmfn07S7qvv.jpg",837],["American Graffiti",1973,3,1,"George Lucas","Comedy, Drama","1tjLivPad2PX8FAzWko7FPIb8d2.jpg",838],["Duel",1971,3.5,1,"Steven Spielberg","Action, Thriller, TV Movie","trhk6fA4Ss2cyiCYvwegLW9OmEM.jpg",839],["Close Encounters of the Third Kind",1977,4,1,"Steven Spielberg","Science Fiction, Drama","gCWPB8cF82tqzrS9tvzcO6q6nyz.jpg",840],["Dune (1984)",1984,2.5,1,"David Lynch","Action, Science Fiction, Adventure","ngUaHgSZGkKy1Izwjk7qwZLOC5A.jpg",841],["In the Mood for Love",2000,4.5,2,"Wong Kar-Wai","Drama, Romance","8BgGbbWiLNhPtkMkN0gGTnbtvBv.jpg",843],["2046",2004,4,1,"Wong Kar-Wai","Drama, Science Fiction, Romance","jIN65qw0Giplo4CshzMrxz204Wn.jpg",844],["Strangers on a Train",1951,4,1,"Alfred Hitchcock","Crime, Thriller, Drama","ihC083U7ef56Ui4x0P0dobojrZ1.jpg",845],["Willow",1988,3.5,1,"Ron Howard","Fantasy, Adventure, Action","pAIRGMIdN7ZdZhflazdV2ezuJ9f.jpg",847],["A Story",1987,2,1,"Bob Clark","Comedy, Family","34nSHYqmb7222tiqiuKqKJmZiQa.jpg",850],["A Christmas Story",1983,2,1,"Bob Clark","Comedy, Family","34nSHYqmb7222tiqiuKqKJmZiQa.jpg",850],["Brief Encounter",1945,4.5,1,"David Lean","Drama, Romance","jC9EwLJcGhYMSQAHu2LxkKN5v7O.jpg",851],["The Mask",1994,4,3,"Chuck Russell","Comedy, Fantasy, Crime, Romance","jPC2eYub74zwf2tPGVtzSlBW6Oy.jpg",854],["Black Hawk Down",2001,3,1,"Ridley Scott","Action, War, History","7fU5dSqKRL4XHeEUz62rCKBfYok.jpg",855],["Who Framed Roger Rabbit",1988,4.5,3,"Robert Zemeckis","Fantasy, Animation, Comedy, Crime","lYfRc57Kx9VgLZ48iulu0HKnM15.jpg",856],["Saving Private Ryan",1998,4.5,1,"Steven Spielberg","War, Drama, History","uqx37cS8cpHg8U35f9U5IBlrCV3.jpg",857],["Sleepless in Seattle",1993,3,1,"Nora Ephron","Comedy, Drama, Romance","jAXfku1u1uaLGh4cUmK0ESf1pPu.jpg",858],["Total Recall",1990,4,1,"Paul Verhoeven","Action, Adventure, Science Fiction","wVbeL6fkbTKSmNfalj4VoAUUqJv.jpg",861],["Toy Story",1995,5,5,"John Lasseter","Family, Comedy, Animation, Adventure","uXDfjJbdP4ijW5hWSBrPrlKpxab.jpg",862],["Toy Story 2",1999,4.5,4,"John Lasseter","Animation, Comedy, Family","4rbcp3ng8n1MKHjpeqW0L7Fnpzz.jpg",863],["The Running Man",1987,2.5,1,"Paul Michael Glaser","Action, Thriller, Science Fiction","GTAUOhO4BN0peJVvxGEQydJvUO.jpg",865],["Finding Neverland",2004,3,1,"Marc Forster","Drama, Fantasy","5JyDPH4qdr0I6pF7Bjh1Qrf1Jhh.jpg",866],["Planet of the Apes (2001)",2001,1.5,1,"Tim Burton","Thriller, Science Fiction, Action, Adventure","3ZWsuP5rExMSji7erxnb1P5SK6F.jpg",869],["Planet of the Apes",1968,4,1,"Franklin J. Schaffner","Science Fiction, Adventure, Drama, Action","2r9iKnlSYEk4daQadsXfcjHfIjQ.jpg",871],["Singin' in the Rain",1952,4,3,"Stanley Donen","Comedy, Romance","w03EiJVHP8Un77boQeE7hg9DVdU.jpg",872],["Scarface (1932)",1932,3,1,"Howard Hawks","Crime, Action, Drama, Thriller","y4E5oRiHMTFkEB12IIcpbKbKzDW.jpg",877],["Hook",1991,2.5,1,"Steven Spielberg","Adventure, Fantasy, Comedy, Family","a6rB1lGXoGms7gWxRfJneQmAjNV.jpg",879],["A Few Good Men",1992,3.5,1,"Rob Reiner","Drama","rLOk4z9zL1tTukIYV56P94aZXKk.jpg",881],["Coffee and Cigarettes",2003,2.5,1,"Jim Jarmusch","Comedy, Drama","pfG02QCsutx3PIxFS8UY4iM9AsS.jpg",883],["Crash",1996,4,1,"David Cronenberg","Thriller, Drama","gpai5oUFyFGLHOCsYTvVMqlbY7A.jpg",884],["The Best Years of Our Lives",1946,4,1,"William Wyler","Drama, Romance, War","gd5EoAU4MM57sW3vlWxJ0NMM8cV.jpg",887],["The Flintstones",1994,1.5,1,"Brian Levant","Fantasy, Comedy, Family","k7gkf5Wa8YZ9iyEOylBMfw9pnkp.jpg",888],["The Flintstones in Viva Rock Vegas",2000,0.5,1,"Brian Levant","Comedy, Family, Romance","qTcf60dqziF7xU2amxIIsvrnkTl.jpg",889],["All the President's Men",1976,4,1,"Alan J. Pakula","Drama, Mystery, Thriller","cPtSHR7D2WGsDBfnC5DxV927hKn.jpg",891],["Delicatessen",1991,3.5,1,"Jean-Pierre Jeunet","Comedy, Science Fiction, Fantasy","gNtOgQHxE5B8e08zuNRAdDpmK5Z.jpg",892],["Andrei Rublev",1966,2.5,1,"Andrei Tarkovsky","Drama, History","910xRIUmNJrWH2hkQifBJtoPp5R.jpg",895],["Apur Sansar",1959,3.5,1,"Satyajit Ray","Drama","6Tz1Q69o2n3Zwb0ZffzPL0nFt2T.jpg",896],["Aparajito",1956,3.5,1,"Satyajit Ray","Drama","qvR2Qs42WHwCEcuwhQnterU3gVY.jpg",897],["Bringing Up Baby",1938,2,1,"Howard Hawks","Comedy, Romance","vTNNOtemaYmtx3k2NpsLMRJKEwZ.jpg",900],["City Lights",1931,4,1,"Charlie Chaplin","Comedy, Drama, Romance","bXNvzjULc9jrOVhGfjcc64uKZmZ.jpg",901],["The City of Lost Children",1995,3,1,"Jean-Pierre Jeunet","Fantasy, Science Fiction, Adventure","whwT3Q9JxbAYzEc3t7uYYcCbTMf.jpg",902],["Cool Hand Luke",1967,4,1,"Stuart Rosenberg","Drama, Crime","4ykzTiHKLamh3eZJ8orVICtU2Jp.jpg",903],["Doctor Zhivago",1965,3,1,"David Lean","Drama, Romance, War","r0Iv2BiCFYDnzc6uU1q3AJ56igT.jpg",907],["Meet Me in St. Louis",1944,3.5,1,"Vincente Minnelli","Comedy, Drama, Romance, Family","ekVeUvG81pidsv2LMtWf5yYcNbq.jpg",909],["The Big Sleep",1946,4,1,"Howard Hawks","Mystery, Crime, Thriller","lraHo9D8c0YWfxsKqT5P5sVqMKN.jpg",910],["The Great Dictator",1940,4.5,1,"Charlie Chaplin","Comedy, War","1QpO9wo7JWecZ4NiBuu625FiY1j.jpg",914],["Bullitt",1968,4,1,"Peter Yates","Action, Crime, Thriller","2ffzF1WmeXtH420fSUoCrecFvDA.jpg",916],["Blind Date",1987,2.5,1,"Blake Edwards","Comedy, Romance","cLb3akSpZhU5qkmCO46IHfJtcs0.jpg",918],["Cars",2006,4,4,"John Lasseter","Animation, Adventure, Comedy, Family","2Touk3m5gzsqr1VsvxypdyHY5ci.jpg",920],["Dead Man",1995,4,1,"Jim Jarmusch","Drama, Fantasy, Western","jX3wGBVoYoAY3IixBpwYk1fjT4z.jpg",922],["Dawn of the Dead",1978,4,1,"George A. Romero","Horror, Science Fiction","70MY8H0bLMvXf8ED2SgVMPhDVVM.jpg",923],["Dawn of the Dead (2004)",2004,3,1,"Zack Snyder","Horror, Science Fiction, Action","ttquyxStEEctzghtA2f4PUGprDr.jpg",924],["Do the Right Thing",1989,4.5,1,"Spike Lee","Drama","63rmSDPahrH7C1gEFYzRuIBAN9W.jpg",925],["Galaxy Quest",1999,3.5,1,"Dean Parisot","Comedy, Science Fiction, Adventure","fZXSwgZknp81vmciTb86rw0MejV.jpg",926],["Gremlins",1984,4,1,"Joe Dante","Fantasy, Horror, Comedy","6m0F7fsXjQvUbCZrPWcJNrjvIui.jpg",927],["Gremlins 2: The New Batch",1990,4.5,1,"Joe Dante","Comedy, Horror, Fantasy","35F5yD7MljvBE2AC0NHAVCoPGEi.jpg",928],["Godzilla (1998)",1998,1,1,"Roland Emmerich","Science Fiction, Action, Thriller","xJVl1I95StraYAwaNbBkVoWE2qA.jpg",929],["Don't Look Now",1973,3.5,1,"Nicolas Roeg","Thriller, Drama, Horror","ivWsU3QtcstImCTOjItsH0SAbNn.jpg",931],["Rififi",1955,3.5,1,"Jules Dassin","Crime, Thriller, Drama","heVdAFNZUxXVmO6jiJcEHCvI5lK.jpg",934],["Dr. Strangelove or: How I Learned to Stop Worrying and Love the Bomb",1964,4.5,2,"Stanley Kubrick","Comedy, War","6x7MzQ6BOMlRzam1StcmPO9v61g.jpg",935],["The Pink Panther",1963,2,1,"Blake Edwards","Comedy, Crime","aCjJ0sKayks2uL7MJBzdp2i67NI.jpg",936],["For a Few Dollars More",1965,4,2,"Sergio Leone","Western","ooqASvA7qxlTVKL3KwOzBwy57Dh.jpg",938],["The Lady Vanishes",1938,3,1,"Alfred Hitchcock","Mystery, Thriller","c1t9LB76LvEARPanfEzXmkm7fwY.jpg",940],["Lethal Weapon",1987,4,1,"Richard Donner","Action, Thriller, Crime","6gt44oqb4nE8vflPElffeGwsHVl.jpg",941],["Lethal Weapon 2",1989,3,1,"Richard Donner","Action, Thriller, Crime","v04YGBUiGMoqxWqjPJrQUfRImFp.jpg",942],["Lethal Weapon 3",1992,2.5,1,"Richard Donner","Action, Thriller, Crime","efOCSdTquRGQFTpTsLYApfBWmJK.jpg",943],["Lethal Weapon 4",1998,2,1,"Richard Donner","Action, Crime, Thriller","1EYNRhKXcMPF2zOPS1nWXoC844w.jpg",944],["Letter from an Unknown Woman",1948,3,1,"Max Ophüls","Drama, Romance","gRGRW7DKyK8qBtKJTWguULMGbHG.jpg",946],["Lawrence of Arabia",1962,4.5,1,"David Lean","Adventure, History, War","AiAm0EtDvyGqNpVoieRw4u65vD1.jpg",947],["Halloween",1978,4.5,3,"John Carpenter","Horror, Thriller","wijlZ3HaYMvlDTPqJoTCWKFkCPU.jpg",948],["Heat",1995,4.5,1,"Michael Mann","Crime, Drama, Action","umSVjVdbVwtx5ryCA2QXL44Durm.jpg",949],["Ice Age: The Meltdown",2006,3,3,"Carlos Saldanha","Animation, Family, Comedy, Adventure","zDduhCHasKQ9YOTvlOreHem7Wbi.jpg",950],["Kindergarten Cop",1990,2.5,1,"Ivan Reitman","Comedy","nKnHWwkXyvhzCYWm3FyRAv3qBrl.jpg",951],["Madagascar",2005,2,1,"Eric Darnell & Tom McGrath","Adventure, Animation, Comedy, Family","zMpJY5CJKUufG9OTw0In4eAFqPX.jpg",953],["Mission: Impossible",1996,3,1,"Brian De Palma","Adventure, Action, Thriller","l5uxY5m5OInWpcExIpKG6AR3rgL.jpg",954],["Mission: Impossible II",2000,2,1,"John Woo","Adventure, Action, Thriller","hfnrual76gPeNFduhD4xzHWpfTw.jpg",955],["Mission: Impossible III",2006,2.5,1,"J.J. Abrams","Adventure, Action, Thriller","vKGYCpmQyV9uHybWDzXuII8Los5.jpg",956],["Spaceballs",1987,2,1,"Mel Brooks","Comedy, Science Fiction","aHNeKtkNnyQcietzi2cgiYL8sC9.jpg",957],["The General",1926,4,2,"Buster Keaton","Action, Adventure, Comedy, War, Romance, Drama","nIp4gIXogCjfB1QABNsWwa9gSca.jpg",961],["The Gold Rush",1925,4.5,1,"Charlie Chaplin","Adventure, Comedy, Drama","eQRFo1qwRREYwj47Yoe1PisgOle.jpg",962],["The Maltese Falcon",1941,4,2,"John Huston","Mystery, Crime, Thriller","bf4o6Uzw5wqLjdKwRuiDrN1xyvl.jpg",963],["The Phantom of the Opera",1925,2.5,1,"Rupert Julian","Horror","mvaYpAYj957C2tlq3vVJPSzGJXK.jpg",964],["The Magnificent Ambersons",1942,4,1,"Orson Welles","Drama, Romance","g5EosvM0delNPkgBDGYYZvJl46n.jpg",965],["The Magnificent Seven",1960,3.5,1,"John Sturges","Western, Action, Adventure, Drama","e5ToxOyJwuZD4VOfI0qEn5uIjeJ.jpg",966],["Spartacus",1960,4,1,"Stanley Kubrick","History, Drama, Adventure","r0Fgg1GyZgzokaiw2HFQv3oPaL2.jpg",967],["Dog Day Afternoon",1975,4.5,1,"Sidney Lumet","Crime, Drama, Thriller","mavrhr0ig2aCRR8d48yaxtD5aMQ.jpg",968],["Paths of Glory",1957,5,4,"Stanley Kubrick","War, Drama","p7OHwomA8UOhe3EhckF2IetBTh9.jpg",975],["Sweet Smell of Success",1957,4,1,"Alexander Mackendrick","Drama","akzvV8JasNrgEl5iAP9K6zPHGJe.jpg",976],["Irreversible",2002,4.5,1,"Gaspar Noé","Drama, Thriller, Crime","rxeDxo8FvZpLu6iplNpxdtAVnfu.jpg",979],["The Philadelphia Story",1940,3.5,1,"George Cukor","Comedy, Romance","dKUubjvxO78XDts6VP1Ggcp4R9O.jpg",981],["Dirty Harry",1971,3.5,1,"Don Siegel","Action, Crime, Thriller","scl2JDHzYoIEs5xyYy5ITCfyY0G.jpg",984],["Eraserhead",1977,3.5,1,"David Lynch","Horror, Science Fiction","mxveW3mGVc0DzLdOmtkZsgd7c3B.jpg",985],["The Hustler",1961,4,1,"Robert Rossen","Drama, Romance","snItsSViawjaadW9mlWUmGwR41R.jpg",990],["The Man Who Fell to Earth",1976,3,1,"Nicolas Roeg","Science Fiction, Drama, Fantasy","gwmPVphE5DMFFGXGMhfEFyxOOYj.jpg",991],["Sherlock Jr.",1924,4,1,"Buster Keaton","Action, Comedy, Mystery","1G9r3rqtbFAQuyWKOZm4Y5J5s7Q.jpg",992],["Sleuth",1972,3.5,1,"Joseph L. Mankiewicz","Thriller, Mystery, Crime","jAREYLUnYGwPjbQr0vs1s38QLkH.jpg",993],["Straw Dogs",1971,4,1,"Sam Peckinpah","Thriller, Drama, Crime","yigkfHE1OhkxPPrjrV78Y9ibGEk.jpg",994],["Stagecoach",1939,3.5,1,"John Ford","Western","zgMnfnwWZ3nkx4t0bUDEKtW24O8.jpg",995],["Double Indemnity",1944,4.5,2,"Billy Wilder","Crime, Thriller","rVNYZZgfhwqVMMWlBmxOfWqnwCj.jpg",996],["Mulholland Drive",2001,5,2,"David Lynch","Thriller, Drama, Mystery","x7A59t6ySylr1L7aubOQEA480vM.jpg",1018],["Adam's Apples",2005,3,1,"Anders Thomas Jensen","Drama, Comedy, Crime","v5KtTI8uFWqOed7dL3nzAvOTCn2.jpg",1023],["Heavenly Creatures",1994,4,1,"Peter Jackson","Drama, Fantasy","uvb86wVCIqD3Rlbr0GTNgWDF7Zo.jpg",1024],["The Leopard",1963,4.5,1,"Luchino Visconti","Drama","riSUxwoK3xjkOgy6YJSvPhi7cO6.jpg",1040],["The French Connection",1971,4,1,"William Friedkin","Action, Crime, Thriller","5XSGvIKl2yPvOkieFjc3rzLw7x0.jpg",1051],["Blow-Up",1966,4.5,1,"Michelangelo Antonioni","Drama, Mystery, Thriller","jVDVpydUw8Z50naUDAG4NbRCrSa.jpg",1052],["The Hidden Fortress",1958,4,1,"Akira Kurosawa","Drama, Action, Adventure","olO4vMPKNIJQxhJh54TPQFwKpad.jpg",1059],["Black Cat, White Cat",1998,3.5,1,"Emir Kusturica","Comedy, Romance, Crime","xxQ9jgYf3xhbUTW98VtCjA1wMLv.jpg",1075],["Point Break",1991,3,1,"Kathryn Bigelow","Action, Thriller, Crime","tlbERIghrQ4oofqlbF7H0K0EYnx.jpg",1089],["The Thing",1982,5,2,"John Carpenter","Horror, Mystery, Science Fiction","tzGY49kseSE9QAKk47uuDGwnSCu.jpg",1091],["The Third Man",1949,4.5,1,"Carol Reed","Thriller, Mystery","wxTbbrWypRgUcsTS9zw7p9tMbNq.jpg",1092],["Escape from New York",1981,2.5,1,"John Carpenter","Action, Thriller, Science Fiction","vH9llaphjAssRGi0k7e75tD40Ce.jpg",1103],["The Prestige",2006,4,2,"Christopher Nolan","Drama, Mystery, Science Fiction","Ag2B2KHKQPukjH7WutmgnnSNurZ.jpg",1124],["Dreamgirls",2006,3,1,"Bill Condon","Drama, Music","sG5JyOj8Spe13QkNJMH8b5kzQUh.jpg",1125],["Babel",2006,3.5,1,"Alejandro G. Iñárritu","Drama","bZByZbvU7u14WjoUJERqCRW9saN.jpg",1164],["The Talented Mr. Ripley",1999,3.5,1,"Anthony Minghella","Thriller, Crime, Drama","6ojHgqtIR41O2qLKa7LFUVj0cZa.jpg",1213],["The Remains of the Day",1993,3,1,"James Ivory","Drama, Romance","uDGDtqSvuch324WnM7Ukdp1bCAQ.jpg",1245],["Rocky Balboa",2006,2.5,1,"Sylvester Stallone","Drama","byBlJvZwCqgtIwrZNv0pyE974jC.jpg",1246],["Ghost Rider",2007,1.5,1,"Mark Steven Johnson","Thriller, Action, Fantasy","d9Oan9XJJ6gRJa64Ifsgp1sXbC4.jpg",1250],["Letters from Iwo Jima",2006,3.5,1,"Clint Eastwood","Action, Drama, War","kZokxQtzMPURvijWYFuvh1fAvnv.jpg",1251],["The Host",2006,4.5,2,"Bong Joon Ho","Horror, Drama, Science Fiction","dEDLY3KeghKFzks5nTDWdigVikr.jpg",1255],["Stranger Than Fiction",2006,3.5,1,"Marc Forster","Drama, Comedy, Romance, Fantasy","nCzcepubwShvZ4vbCsygQNgF2Z1.jpg",1262],["Meet the Robinsons",2007,2.5,1,"Stephen J. Anderson","Animation, Comedy, Family, Science Fiction, Adventure","naya0zF4kT401Sx15AtwB9vpcJr.jpg",1267],["Mr. Bean's Holiday",2007,1.5,1,"Steve Bendelack","Family, Comedy","bSSx9Sq6irWwN9NTQmoT9KE8kXn.jpg",1268],["300",2006,2.5,1,"Zack Snyder","Action, Adventure, War","h7Lcio0c9ohxPhSZg42eTlKIVVY.jpg",1271],["Sunshine",2007,3,1,"Danny Boyle","Science Fiction, Thriller","oKGGeJ8qvm0UmClz43VJ31fzPP7.jpg",1272],["TMNT",2007,1.5,1,"Kevin Munroe","Adventure, Animation, Comedy, Family","6ZCWn7BGpDLBDigtdiuGyBdEqab.jpg",1273],["The Dreamers",2003,4,1,"Bernardo Bertolucci","Drama, Romance","gBb7GGaFYPu7nEUYvC8G4LaJJN1.jpg",1278],["Samaritan Girl",2004,3.5,1,"Kim Ki-duk","Drama","w0cn9vwzkheuCT2a2MStdnadOyh.jpg",1279],["3-Iron",2004,5,1,"Kim Ki-duk","Drama, Romance, Crime","8ens4pTquSxN7J9EgL0NOehWwdZ.jpg",1280],["Bean",1997,2.5,1,"Mel Smith","Family, Adventure, Comedy","IwrDPrB4d2DMcpnGkvan46yINL.jpg",1281],["American Psycho",2000,3.5,1,"Mary Harron","Thriller, Drama, Crime","9uGHEgsiUXjCNq8wdq4r49YL8A1.jpg",1359],["Rocky",1976,4.5,1,"John G. Avildsen","Drama","hEjK9A9BkNXejFW4tfacVAEHtkn.jpg",1366],["Rocky II",1979,3,1,"Sylvester Stallone","Drama","nMaiiu0CzT77U4JZkUYV7KqdAjK.jpg",1367],["First Blood",1982,3,1,"Ted Kotcheff","Action, Thriller, Drama","a9sa6ERZCpplbPEO7OMWE763CLD.jpg",1368],["Rocky III",1982,2.5,1,"Sylvester Stallone","Drama","uqw16i2kmwVqkJHzjzbDU4xZ0Pl.jpg",1371],["Blood Diamond",2006,3,1,"Edward Zwick","Drama, Thriller, Action","bqKNoySmI4eOjsSjJEnLj4j2HAp.jpg",1372],["Rocky IV",1985,2.5,1,"Sylvester Stallone","Drama","2MHUit4H6OK5adcOjnCN6suCKOl.jpg",1374],["Rocky V",1990,2,1,"John G. Avildsen","Drama","tevHaVxtrMTaUi8f3YjLWYSSY8A.jpg",1375],["Shortbus",2006,3,1,"John Cameron Mitchell","Romance, Drama, Comedy","s8QBrWgpZpYrySSyTQ0xbFLPKrS.jpg",1378],["The Fountain",2006,3,1,"Darren Aronofsky","Drama, Adventure, Science Fiction, Romance","4XTf8GuCVLWolubANaKkpk62YPq.jpg",1381],["Superstar: The Karen Carpenter Story",1987,4,1,"Todd Haynes","Drama, Music, History","8kMRTa9K442K1D5d0tQYqyFsZh9.jpg",1387],["Out of Sight",1998,3.5,1,"Steven Soderbergh","Romance, Comedy, Crime","v49q7AMR3pB4M762woWB1NYMCLF.jpg",1389],["Y Tu Mamá También",2001,3.5,1,"Alfonso Cuarón","Drama, Romance","aj3rqjab8jfc2fWmcS3H3c5qbur.jpg",1391],["Nostalgia",1983,3.5,1,"Andrei Tarkovsky","Drama, Romance","fCYSidPXp3LpDa9wlLNv0gZvjyF.jpg",1394],["Mirror",1975,5,1,"Andrei Tarkovsky","Drama, History","q1eQeioabtZaD3hz5Fu3v2s16Ad.jpg",1396],["Stalker",1979,4,1,"Andrei Tarkovsky","Science Fiction, Drama","1qhOyf5C4s9ZdvY8d5JDx9DFMeT.jpg",1398],["The Pursuit of Happyness",2006,2,1,"Gabriele Muccino","Drama","lBYOKAMcxIvuk9s9hMuecB9dPBV.jpg",1402],["Dark Star",1974,2,1,"John Carpenter","Comedy, Science Fiction","aiqLBiH0IWrog2Q78dZTT8Ad9Sp.jpg",1410],["sex, lies, and videotape",1989,4,1,"Steven Soderbergh","Drama","pj1uKm07svgXZDHbYE8AzRfNHcu.jpg",1412],["Pan's Labyrinth",2006,5,2,"Guillermo del Toro","Fantasy, Drama, War","z7xXihu5wHuSMWymq5VAulPVuvg.jpg",1417],["The Departed",2006,4,4,"Martin Scorsese","Drama, Thriller, Crime","nT97ifVT2J1yMQmeq20Qblg61T.jpg",1422],["Perfume: The Story of a Murderer",2006,3,1,"Tom Tykwer","Crime, Fantasy, Drama","2wrFrUej8ri5EpjgIkjKTAnr686.jpg",1427],["25th Hour",2002,4,1,"Spike Lee","Crime, Drama","uW7tTRElr2tRhmAVESzvHy4ByXg.jpg",1429],["Bowling for Columbine",2002,4,1,"Michael Moore","Documentary, Drama","4XsiTsZcNCRSkee1o0fdr5OqYRT.jpg",1430],["The Devil's Backbone",2001,3.5,1,"Guillermo del Toro","Fantasy, Drama, Horror, Thriller","iP1z1aJzPnkP8FHg77TS7ukqoEZ.jpg",1433],["The Virgin Suicides",1999,4,1,"Sofia Coppola","Drama, Romance","1NCQtXPQnaHRjOZVmktA9BSM35F.jpg",1443],["Superman Returns",2006,2,1,"Bryan Singer","Science Fiction, Action, Adventure","385XwTQZDpRX2d3kxtnpiLrjBXw.jpg",1452],["Touch of Evil",1958,3.5,1,"Orson Welles","Crime, Thriller, Drama","1pvRgmfBaoMczIJBOi9gCOZ4FMC.jpg",1480],["Hellboy",2004,3.5,1,"Guillermo del Toro","Fantasy, Action","lbaTEneOofwvAyg77R8HbFML2zT.jpg",1487],["The Illusionist",2006,3,1,"Neil Burger","Fantasy, Drama, Thriller, Romance","1O9jUvqkHaGBMVRyOJz1AlkmALW.jpg",1491],["Miss Congeniality",2000,2,1,"Donald Petrie","Comedy, Crime, Action","pat3vKaRlB70he4ghwTMydR4TvP.jpg",1493],["Kingdom of Heaven",2005,3,1,"Ridley Scott","Drama, Action, Adventure, History, War","rNaBe4TwbMef71sgscqabpGKsxh.jpg",1495],["The Last King of Scotland",2006,3,1,"Kevin Macdonald","Drama","mTtgpH6UnHUtD8moRJUzfGLOZTj.jpg",1523],["Collateral",2004,3.5,1,"Michael Mann","Drama, Crime, Thriller","nV5316WUsVij8sVXLCF1g7TFitg.jpg",1538],["Thelma & Louise",1991,3.5,1,"Ridley Scott","Drama, Crime, Adventure","gQSUVGR80RVHxJywtwXm2qa1ebi.jpg",1541],["Office Space",1999,3,1,"Mike Judge","Comedy","v7fBXxHZ5WQn2PGgpXhTqHgtcJk.jpg",1542],["The Lost Boys",1987,2.5,1,"Joel Schumacher","Horror, Comedy, Thriller","nH1lvyQvfbL5GKScTtT6zkIvDEn.jpg",1547],["Ghost World",2001,4.5,1,"Terry Zwigoff","Comedy, Drama","uwKqnUPE4dSM0kKuMW0vXpURh2T.jpg",1548],["Parenthood",1989,3.5,1,"Ron Howard","Comedy, Drama","e51tNNQBJpJi9xkyuj0QFhyBcz7.jpg",1552],["Funeral Parade of Roses",1969,4.5,1,"Toshio Matsumoto","Drama","7cRQ6rSGajW2soWDr3voEN2rgYO.jpg",1556],["Sans Soleil",1983,3,1,"Chris Marker","Documentary","sspJu9K03FZQP8A1cheurkiePD0.jpg",1563],["Live Free or Die Hard",2007,2,1,"Len Wiseman","Action, Thriller","31TT47YjBl7a7uvJ3ff1nrirXhP.jpg",1571],["Die Hard With a Vengeance",1995,4,2,"John McTiernan","Action, Thriller","buqmCdFQEWwEpL3agGgg2GVjN2d.jpg",1572],["Die Hard 2",1990,3.5,1,"Renny Harlin","Action, Thriller","ybki0UWO3OPhaM6MSniuKC7sy1R.jpg",1573],["Chicago",2002,3.5,1,"Rob Marshall","Comedy, Crime, Drama","3ED8cWCXY9zkx77Sd0N5qMbsdDP.jpg",1574],["Resident Evil",2002,2,1,"Paul W. S. Anderson","Horror, Action, Science Fiction","1UKNef590A0ZaMnxsscIcWuK1Em.jpg",1576],["Resident Evil: Apocalypse",2004,1.5,1,"Alexander Witt","Horror, Action, Science Fiction","way9dOm4dM2sm9UMcu2PEXMTX0q.jpg",1577],["Raging Bull",1980,5,5,"Martin Scorsese","Drama, History","1WV7WlTS8LI1L5NkCgjWT9GSW3O.jpg",1578],["Apocalypto",2006,3.5,1,"Mel Gibson","Action, Drama, History","cRY25Q32kDNPFDkFkxAs6bgCq3L.jpg",1579],["Rope",1948,3.5,1,"Alfred Hitchcock","Thriller, Crime, Drama","9ar6rxLDB8kagAnXZKn6h9smscr.jpg",1580],["The Holiday",2006,3,1,"Nancy Meyers","Comedy, Romance","n26GUumac5MrzpJiv0DPI7MMIUJ.jpg",1581],["School of Rock",2003,4,4,"Richard Linklater","Comedy, Family, Music","zXLXaepIBvFVLU25DH3wv4IPSbe.jpg",1584],["It's a Wonderful Life",1946,4.5,1,"Frank Capra","Drama, Family, Fantasy","bSqt9rhDZx1Q7UZ86dBPKdNomp2.jpg",1585],["What's Eating Gilbert Grape",1993,3.5,1,"Lasse Hallström","Romance, Drama","8FxWgsfDNosewo7H65oE4QkOb7g.jpg",1587],["Bring It On",2000,2.5,1,"Peyton Reed","Comedy","bnVby0qI0dS7YunbShP7mw68HY3.jpg",1588],["Primal Fear",1996,3,1,"Gregory Hoblit","Crime, Drama, Thriller","qJf2TzE8nRTFbFMPJNW6c8mI0KU.jpg",1592],["Night at the Museum",2006,3,1,"Shawn Levy","Fantasy, Family, Comedy","pDsAAYf6Zn0yiAGJ6lYGs6hoZ4E.jpg",1593],["Meet the Parents",2000,3,1,"Jay Roach","Comedy, Romance","5tXJ9ctuyEOMUFLaeqRisbXowWs.jpg",1597],["Cape Fear (1991)",1991,4,1,"Martin Scorsese","Drama, Crime, Thriller","ws4mrtndzgSH5QGCamOFAgilr2R.jpg",1598],["The Double Life of Véronique",1991,4.5,1,"Krzysztof Kieślowski","Drama, Fantasy","oqRyO9xrNBRaxqF9pCHHgLuaATx.jpg",1600],["A Bronx Tale",1993,4,1,"Robert De Niro","Drama, Crime","sDbO6LmLYtyqAoFTPpRcMgPSCEO.jpg",1607],["Hitman",2007,1.5,1,"Xavier Gens","Action, Thriller, Drama","h69UJOOKlrHcvhl5H2LY74N61DQ.jpg",1620],["Trading Places",1983,3.5,1,"John Landis","Comedy","8mBuLCOcpWnmYtZc4aqtvDXslv6.jpg",1621],["Liar Liar",1997,3.5,1,"Tom Shadyac","Comedy, Fantasy","p1habYSdC7oD3WygQ5lynU5G5rV.jpg",1624],["Vivre Sa Vie",1962,4.5,1,"Jean-Luc Godard","Drama","A0BjScjASfMFgyGI5sU0CwfKh3l.jpg",1626],["Jules and Jim",1962,3,1,"François Truffaut","Drama, Romance","kuFjZlcZhQFDtIjuI3GQJjsQG03.jpg",1628],["The People vs. Larry Flynt",1996,3,1,"Miloš Forman","Drama","sAgHn7ys6TiVXBDTZ0UBEjinIUk.jpg",1630],["Mississippi Burning",1988,3.5,1,"Alan Parker","Drama, Crime, Mystery, Thriller","hTv8Bkq3W1vwKi1IWCLWQW9PNU4.jpg",1632],["Free Willy",1993,1.5,1,"Simon Wincer","Family, Adventure, Drama","9iBgd9gi9ztWiVcYSG6zl8wDFBN.jpg",1634],["The Island",2005,2.5,1,"Michael Bay","Action, Thriller, Science Fiction","9MaZYEyFmQwNeDTxZGQEN8E0e4p.jpg",1635],["Bedazzled",2000,3.5,2,"Harold Ramis","Fantasy, Comedy, Romance","sBV28EVvWsJRosMsEFCbVmpAZEl.jpg",1636],["Speed",1994,3.5,1,"Jan de Bont","Action, Thriller","82PkCE4R95KhHICUDF7G4Ly2z3l.jpg",1637],["Speed 2: Cruise Control",1997,1,1,"Jan de Bont","Action, Thriller","gnK1ocpwUTj24zAktzomOJsD2bu.jpg",1639],["Crash (2004)",2004,3,1,"Paul Haggis","Drama","86BdPC6RDX88NC880pLidKn2LCj.jpg",1640],["Last Tango in Paris",1972,4,1,"Bernardo Bertolucci","Drama, Romance","dNgdUdNOWfHsZI3lDu6Epig7H2P.jpg",1643],["Bill & Ted's Excellent Adventure",1989,3,1,"Stephen Herek","Adventure, Comedy, Science Fiction","tV25lGWGWGEqUe3U0xjQTBgilSx.jpg",1648],["Bill & Ted's Bogus Journey",1991,3,1,"Peter Hewitt","Adventure, Comedy, Science Fiction","tldtDfLnPFOtTWp758EmIP2Hbz5.jpg",1649],["The Motorcycle Diaries",2004,3.5,1,"Walter Salles","Drama","qz2aBYT8CAiJYvX4fRZpJ5G0Oz1.jpg",1653],["The Dirty Dozen",1967,3.5,1,"Robert Aldrich","Action, Adventure, War","tFWWsuhp22zJ6OG6QepJIiPUfeF.jpg",1654],["The Legend of Zorro",2005,3,1,"Martin Campbell","Action, Adventure, Western","93iEBX1QbsxAv8eSybe8lhLXY1A.jpg",1656],["March of the Penguins",2005,3.5,1,"Luc Jacquet","Documentary, Family","o9xJ1xG1WKlHkl8ACqq0LShOuMu.jpg",1667],["Day for Night",1973,4.5,1,"François Truffaut","Comedy, Drama","vUNdp6wRA7177aww0MPvocnu4xf.jpg",1675],["Godzilla",1954,4,1,"Ishirō Honda","Thriller, Horror, Science Fiction","2W0Yw0qrgVMgdsSCZRKtfvaAh0i.jpg",1678],["Godzilla Raids Again",1955,2,1,"Motoyoshi Oda","Science Fiction, Horror, Action","bBYdh9tDCyLaArBOzE38QCA7C3y.jpg",1679],["King Kong vs. Godzilla",1962,2.5,1,"Ishirō Honda","Science Fiction, Fantasy, Action","dmCfyzUl0Ylk8Rpi6dYyWuBrnNr.jpg",1680],["Mothra vs. Godzilla",1964,3.5,1,"Ishirō Honda","Drama, Action, Science Fiction","y49vvM03gpuyhpyMc1f55VrNkP3.jpg",1682],["The Reaping",2007,1.5,1,"Stephen Hopkins","Horror","o8Vl4Vxp5LBth9J6Aa3k6PAefxt.jpg",1683],["Beneath the Planet of the Apes",1970,2,1,"Ted Post","Adventure, Science Fiction, Mystery","szHCeYwi4ubewuYnlnz0YGqWnQC.jpg",1685],["Escape from the Planet of the Apes",1971,3.5,1,"Don Taylor","Action, Science Fiction","AnbLVdUEroTfHTUVAJCxkL4R0IH.jpg",1687],["Conquest of the Planet of the Apes",1972,2.5,1,"J. Lee Thompson","Action, Science Fiction","lZ1pUxJCO14ObrhDuxTBuYm0tjN.jpg",1688],["Re-Animator",1985,4,1,"Stuart Gordon","Science Fiction, Comedy, Horror","1hY6AUl92cL9GdZx031UWFiGETt.jpg",1694],["The Devil's Rejects",2005,1.5,1,"Rob Zombie","Drama, Horror, Crime","drZz4AuI7trq6BxlH9Xa4v4O0Pb.jpg",1696],["Misery",1990,4,1,"Rob Reiner","Drama, Thriller","klPO5oh1LOxiPpdDXZo1ADgpKcw.jpg",1700],["Con Air",1997,2.5,1,"Simon West","Action, Thriller, Crime","kOKjgrEzGOP92rVQ6srA9jtp60l.jpg",1701],["Battle for the Planet of the Apes",1973,1.5,1,"J. Lee Thompson","Action, Science Fiction","dP5dYjLp5p2CG103cJMio4Nj29d.jpg",1705],["Fahrenheit 451",1966,3,1,"François Truffaut","Drama, Science Fiction","k2CTpexoS9MO9lKVFfnzwVdJuM.jpg",1714],["The Incredible Hulk",2008,2.5,1,"Louis Leterrier","Science Fiction, Action, Adventure","gKzYx79y0AQTL4UAk1cBQJ3nvrm.jpg",1724],["West Side Story",1961,4,2,"Robert Wise","Crime, Drama, Romance","nzCMu6D5q60i2bVrIQ0DxlRSgCZ.jpg",1725],["Iron Man",2008,3.5,2,"Jon Favreau","Adventure, Science Fiction, Action","78lPtwv72eTNqFW9COBYI0dWDJa.jpg",1726],["Inland Empire",2006,3.5,1,"David Lynch","Horror, Thriller, Mystery, Drama, Fantasy","1ypMcAcqTZrcxFJvERemKc6t9sX.jpg",1730],["The Mummy (2017)",2017,1.5,1,"Alex Kurtzman","Adventure, Action, Fantasy","kdJsW7hcy1lrj7tdMPycTAQPAiR.jpg",1734],["The Mummy Returns",2001,3.5,1,"Stephen Sommers","Adventure, Action, Fantasy","kdJsW7hcy1lrj7tdMPycTAQPAiR.jpg",1734],["The Mummy: Tomb of the Dragon Emperor",2008,1.5,1,"Rob Cohen","Adventure, Action, Fantasy","A3acM1lX5PNWQa6r5qeMAJOxbnT.jpg",1735],["Next",2007,1.5,1,"Lee Tamahori","Action, Science Fiction, Thriller","wtBOCJBCP0MWNjmBwjMAzbwgtTK.jpg",1738],["Captain America: The First Avenger",2011,2,1,"Joe Johnston","Action, Adventure, Science Fiction","vSNxAJTlD0r02V9sPYpOjqDZXUK.jpg",1771],["Footloose",1984,2.5,1,"Herbert Ross","Drama, Romance","9JEDjBCXCx3eKTSkXwispf0UN3O.jpg",1788],["The Piano Teacher",2001,4.5,1,"Michael Haneke","Drama, Romance","gNHKYQnP1RnqEhkivHJzBPb4MOP.jpg",1791],["Elephant (2003)",2003,4.5,1,"Gus Van Sant","Crime, Drama","1a4VU9z2hxEvugHMK7VsobB9xTX.jpg",1807],["Velvet Goldmine",1998,4,1,"Todd Haynes","Drama, Music","bsuSac0PldPFcOtR1Vioe7VBF4l.jpg",1808],["Viva Zapata!",1952,3,1,"Elia Kazan","History, Drama, Western","vfarxn9ddiaZpRDml8FGhB46Qrc.jpg",1810],["Nowhere",1997,3.5,1,"Gregg Araki","Comedy, Drama, Science Fiction","c1TZKfzvATep5x5DthqWjjWtU2l.jpg",1811],["The Devil's Advocate",1997,2.5,1,"Taylor Hackford","Horror, Drama, Mystery","5ZzBGpxy55OQzHxKVY11IpY6a0o.jpg",1813],["Phone Booth",2002,2,1,"Joel Schumacher","Thriller, Crime","r6lIwPKVDa6Q76qH2TbIBqPhXL3.jpg",1817],["Shoot the Piano Player",1960,3,1,"François Truffaut","Drama, Thriller, Crime","6UhMIZaaoe2HUU7sEIwYpuYgugh.jpg",1818],["You, Me and Dupree",2006,2,1,"Anthony Russo & Joe Russo","Comedy, Romance","rtqbg1CKR4dFdmHxmsiM3u9n71I.jpg",1819],["50 First Dates",2004,2.5,1,"Peter Segal","Comedy, Romance","lzUI2Cg7OMfcUNv3f7MywYNBjs6.jpg",1824],["Dogma",1999,2,1,"Kevin Smith","Fantasy, Comedy, Adventure","oxhHl2YokTqcP44QK5tiTgjgLgk.jpg",1832],["Entrapment",1999,2,1,"Jon Amiel","Romance, Drama, Mystery","psrm7DToacaxQvgViBAcrYiLKzH.jpg",1844],["The Long Goodbye",1973,3,1,"Robert Altman","Crime, Drama, Mystery","oBhUK54yBJ0aH6u9zCzSV5iV7OP.jpg",1847],["Man on the Moon",1999,4,1,"Miloš Forman","Comedy, Drama, History","d8rahmdfryjdmvLpSsDOUhGVQXl.jpg",1850],["Transformers",2007,2,1,"Michael Bay","Adventure, Science Fiction, Action","4N4sipl8T72tNE4earcctQa2Kw2.jpg",1858],["Ninotchka",1939,3,1,"Ernst Lubitsch","Comedy, Romance","v4MkgNqZyodYwBDNbZ64MF9tVEL.jpg",1859],["Pirates of the Caribbean: On Stranger Tides",2011,2,1,"Rob Marshall","Adventure, Action, Fantasy","keGfSvCmYj7CvdRx36OdVrAEibE.jpg",1865],["Fear and Loathing in Las Vegas",1998,3,1,"Terry Gilliam","Adventure, Drama, Comedy","tisNLcMkxryU2zxhi0PiyDFqhm0.jpg",1878],["Guess Who's Coming to Dinner",1967,3.5,1,"Stanley Kramer","Drama, Romance","fkHeYWahNbhxhuLefaAg553lYo5.jpg",1879],["Malcolm X",1992,4.5,1,"Spike Lee","Drama, History","o2s9ow0uRRm1BcF3teznk5twd90.jpg",1883],["The Ewok Adventure",1984,1.5,1,"John Korty","Adventure, Family, Fantasy, Science Fiction, TV Movie","4GrECLKaJhYA6ooSTOG0XEuPnSl.jpg",1884],["The Karate Kid",1984,3,1,"John G. Avildsen","Action, Drama, Family","1mp4ViklKvA0WXXsNvNx0RBuiit.jpg",1885],["Marie Antoinette",2006,3,1,"Sofia Coppola","Drama, History","cybXGmv8Rjd5Os8Xml6YxMBQ0Zt.jpg",1887],["The Empire Strikes Back",1980,5,4,"Irvin Kershner","Adventure, Action, Science Fiction","nNAeTmF4CtdSgMDplXTDPOpYzsX.jpg",1891],["Return of the Jedi",1983,3.5,4,"Richard Marquand","Adventure, Action, Science Fiction","jQYlydvHm3kUix1f8prMucrplhm.jpg",1892],["Star Wars: Episode I – The Phantom Menace",1999,2.5,1,"George Lucas","Adventure, Action, Science Fiction","6wkfovpn7Eq8dYNKaG5PY3q2oq6.jpg",1893],["Star Wars: Episode II – Attack of the Clones",2002,2,1,"George Lucas","Adventure, Action, Science Fiction","oZNPzxqM2s5DyVWab09NTQScDQt.jpg",1894],["Star Wars: Episode III – Revenge of the Sith",2005,3,4,"George Lucas","Adventure, Action, Science Fiction","xfSAoBEm9MNBjmlNcDYLvLSMlnq.jpg",1895],["Traffic",2000,4,1,"Steven Soderbergh","Thriller, Drama, Crime","jbccmnqE4oAPI67bApgt2JiRPz8.jpg",1900],["Open Your Eyes",1997,4,1,"Alejandro Amenábar","Drama, Thriller, Science Fiction","x6g4veF2EUZHEu6hrW8TfTTzjU0.jpg",1902],["Vanilla Sky",2001,2,1,"Cameron Crowe","Mystery, Romance, Science Fiction","cAh2pCiNPftsY3aSqJuIOde7uWr.jpg",1903],["The Beach",2000,2,1,"Danny Boyle","Drama, Adventure, Romance, Thriller","4y7LxD8TSi6AtsM2xSYqUm1gu7u.jpg",1907],["The Sea Inside",2004,4,1,"Alejandro Amenábar","Drama","mQW1JJKCUg02cmWBzr9JFu9vM1V.jpg",1913],["Twin Peaks: Fire Walk with Me",1992,4,2,"David Lynch","Drama, Mystery, Horror","mxsGXqetGnirf99qapYd5MMY1VL.jpg",1923],["Superman",1978,2.5,1,"Richard Donner","Science Fiction, Action, Adventure","d7px1FQxW4tngdACVRsCSaZq0Xl.jpg",1924],["Hulk",2003,2,1,"Ang Lee","Science Fiction, Adventure, Action, Drama","UllIft2jLSBaay3zQyMV4GNdfy.jpg",1927],["The Amazing Spider-Man",2012,2,2,"Marc Webb","Action, Adventure, Science Fiction","jexoNYnPd6vVrmygwF6QZmWPFdu.jpg",1930],["The Others",2001,3.5,1,"Alejandro Amenábar","Horror, Mystery, Thriller","p8g1vlTvpM6nr2hMMiZ1fUlKF0D.jpg",1933],["Shakespeare in Love",1998,2,1,"John Madden","Romance, History, Comedy, Drama","zdW7jdzPi4J9KZR3TyY2jn3Xh5e.jpg",1934],["Laura",1944,3,1,"Otto Preminger","Drama, Mystery","j0zEiFFrdbZnMXqD3piOtZBJeNB.jpg",1939],["eXistenZ",1999,3.5,1,"David Cronenberg","Action, Thriller, Science Fiction","kETKF0JhdTPn1knci8CAdYL0d79.jpg",1946],["Crank",2006,2.5,1,"Brian Taylor","Action, Thriller, Crime","rsKmhnvzJezjwC1Ud2Hh37oNpdQ.jpg",1948],["Zodiac",2007,4.5,1,"David Fincher","Crime, Mystery, Thriller","6YmeO4pB7XTh8P8F960O1uA14JO.jpg",1949],["The Butterfly Effect",2004,3,1,"Eric Bress","Science Fiction, Thriller","ea5iv7TWMh18fOKoRGgmtcg85Gx.jpg",1954],["The Elephant Man",1980,4.5,1,"David Lynch","Drama, History","u0wpPYjuSt8DIe1Y3Vapnh8jcKE.jpg",1955],["Gerry",2002,1.5,1,"Gus Van Sant","Drama, Adventure, Mystery","jzuPVECdfWuHoBIqQEFajbSwwpa.jpg",1956],["Alexander",2004,2,1,"Oliver Stone","War, History, Action, Adventure, Drama, Romance","jrwQu72sGwGqwE8Ijne89PSIvhp.jpg",1966],["The Grudge",2004,2.5,1,"Takashi Shimizu","Horror, Mystery, Thriller","7vPAVPKYexQVmvC578wPLn2CGCL.jpg",1970],["Fantastic Four: Rise of the Silver Surfer",2007,1.5,1,"Tim Story","Science Fiction, Adventure, Action","9wRfzTcMyyzkQxVDqBHv8RwuZOv.jpg",1979],["The Constant Gardener",2005,3,1,"Fernando Meirelles","Drama, Mystery, Thriller","nkXq7V7mmJVbvwZGr3nxkHo7HkS.jpg",1985],["Benny's Video",1992,4,1,"Michael Haneke","Crime, Drama","o7hoPVLasBxp6iMmehCJbNhucLb.jpg",1987],["My Blueberry Nights",2007,3.5,1,"Wong Kar-Wai","Drama, Romance","w9w3m2IB9QRZXxi6R51ZamKv3HS.jpg",1989],["Death Proof",2007,3,1,"Quentin Tarantino","Action, Thriller","vtu6H4NWnQVqEp3aanUq3hNeeot.jpg",1991],["Planet Terror",2007,3,1,"Robert Rodriguez","Horror, Action, Thriller","3705GxG0RN9XDV5y9IiXKYHw1fK.jpg",1992],["Lara Croft: Tomb Raider",2001,2,1,"Simon West","Adventure, Action, Fantasy","ye5h6fhfz8TkKV4QeuTucvFzxB9.jpg",1995],["Lara Croft: Tomb Raider – The Cradle of Life",2003,2,1,"Jan de Bont","Adventure, Action, Fantasy","ylIEGeAr2ygSClK4FDj9mi2Ah22.jpg",1996],["Aguirre, the Wrath of God",1972,3.5,1,"Werner Herzog","History, Adventure, Drama","qMk93yMo82svW27FEjudgueBMUL.jpg",2000],["Sister Act",1992,3,1,"Emile Ardolino","Music, Comedy","xZvVSZ0RTxIjblLV87vs7ADM12m.jpg",2005],["Persepolis",2007,4,1,"Marjane Satrapi","Animation, Drama","aU8i2QAdTyRR1nYb36Gq51xXP8p.jpg",2011],["The Diving Bell and the Butterfly",2007,4,1,"Julian Schnabel","Drama, History","6NkJ4gnLrvLj0PZDW6sNM85JMbj.jpg",2013],["Mr. Deeds",2002,1.5,1,"Steven Brill","Comedy, Romance","7gGk3pkpRsNlJ4PrJgEfgY9PG43.jpg",2022],["The Patriot",2000,2.5,1,"Roland Emmerich","Drama, History, War, Action","fWZd815QxUCUcrWQZwUkAp9ljG.jpg",2024],["Say Anything...",1989,2.5,1,"Cameron Crowe","Romance, Comedy, Drama","nkucKciFGSRalw6dJtsglWqOXMC.jpg",2028],["Training Day",2001,3.5,1,"Antoine Fuqua","Action, Crime, Drama","bUeiwBQdupBLQthMCHKV7zv56uv.jpg",2034],["Moonstruck",1987,1.5,1,"Norman Jewison","Comedy, Drama, Romance","2mnVWpvsHEHHnfvLn1NXYVvBGl5.jpg",2039],["I, Robot",2004,2.5,1,"Alex Proyas","Action, Science Fiction","efwv6F2lGaghjPpBRSINHtoEiZB.jpg",2048],["The Station Agent",2003,3.5,1,"Tom McCarthy","Drama, Comedy","kjJg6eJa9I9flfHaJG67ecEv8YX.jpg",2056],["National Treasure",2004,3,1,"Jon Turteltaub","Adventure, Action, Mystery","pxL6E4GBOPUG6CdkO9cUQN5VMwI.jpg",2059],["Ratatouille",2007,4.5,2,"Brad Bird","Animation, Comedy, Family, Fantasy","t3vaWRPSf6WjDSamIkKDs1iQWna.jpg",2062],["X-Men Origins: Wolverine",2009,1.5,1,"Gavin Hood","Adventure, Action, Science Fiction","yj8LbTju1p7CUJg7US2unSBk33s.jpg",2080],["Halloween (2007)",2007,2.5,1,"Rob Zombie","Horror","cD8JrfSEI4j7WVnKM1GdiYzMoUh.jpg",2082],["American Pie",1999,2,1,"Paul Weitz","Comedy, Romance","5P68by2Thn8wHAziyWGEw2O7hco.jpg",2105],["The Breakfast Club",1985,4,1,"John Hughes","Comedy, Drama","wM9ErA8UVdcce5P4oefQinN8VVV.jpg",2108],["Rush Hour",1998,3,1,"Brett Ratner","Action, Comedy, Crime","nwPhAsfnb7f46bZkWLG7IRP5HXr.jpg",2109],["L.A. Confidential",1997,4,1,"Curtis Hanson","Crime, Mystery, Thriller","lWCgf5sD5FpMljjpkRhcC8pXcch.jpg",2118],["Me, Myself & Irene",2000,2.5,1,"Peter Farrelly & Bobby Farrelly","Comedy","rvRrcbLbpn7UJGRH1JupgHOeJFq.jpg",2123],["The Perfect Storm",2000,2.5,1,"Wolfgang Petersen","Drama, Adventure, Action","vJPoxqgpfFNbGi0HyoNsjFeLCio.jpg",2133],["Cop Land",1997,3,1,"James Mangold","Crime, Drama, Thriller","bUXaWZPj7qzXjKc2s3Pwdkhxh2o.jpg",2142],["The Cotton Club",1984,3,1,"Francis Ford Coppola","Crime, Drama","qigf5fWSH1tw7z424UVKg71UIOS.jpg",2148],["The Driver",1978,3,1,"Walter Hill","Crime, Thriller, Action","zSpk2OH4MCgLGB06XDv4YUfBTv6.jpg",2153],["The Bottom of the Sea",2003,3,1,"Damián Szifron","Adventure, Drama, Science Fiction","eBm2BUvRwGwxr3hfAaOJ8kVuuhw.jpg",2160],["Fantastic Voyage",1966,2.5,1,"Richard Fleischer","Science Fiction, Adventure","hEWWLe1Lrk58gle3IKCnjBScfzO.jpg",2161],["Wet Hot American Summer",2001,2.5,1,"David Wain","Comedy","skKRPj1Cdsxqzn8BwKxvNV20rRW.jpg",2171],["Tenacious D in The Pick of Destiny",2006,3,1,"Liam Lynch","Comedy, Music, Fantasy, Adventure","7NmDIj5I1OFOZfYFnS3uWtM7WMO.jpg",2179],["Death at a Funeral",2007,3.5,1,"Frank Oz","Comedy, Drama","xyTxrJnjbSJQzcbKIP6S1uqLuxy.jpg",2196],["Eastern Promises",2007,4,1,"David Cronenberg","Thriller, Crime, Mystery","dpiJWb4NrWgcOg2rusuLhDM0hTm.jpg",2252],["Chasing Amy",1997,2.5,1,"Kevin Smith","Comedy, Drama, Romance","tqydORBcNlQxy3ijgSpPurgDHM2.jpg",2255],["Paris Je T'aime",2006,3.5,1,"MANY","Drama, Romance","mcke8Uvw8QDToAZQ94UGo7VU0g6.jpg",2266],["The Golden Compass",2007,1.5,1,"Chris Weitz","Adventure, Fantasy","mIHV28g4Zhbc8yhnhOixa8m4p5O.jpg",2268],["Stardust",2007,3.5,1,"Matthew Vaughn","Adventure, Fantasy, Romance, Family","7zbFmxy3DqKYL2M8Hop6uylp2Uy.jpg",2270],["Bicentennial Man",1999,2.5,1,"Chris Columbus","Drama, Romance, Science Fiction","wrs23eO0VEWwOQpXoOasMnlW9Y4.jpg",2277],["Big",1988,3.5,1,"Penny Marshall","Fantasy, Drama, Comedy","eWhCDJiwxvx3YXkAFRiHjimnF0j.jpg",2280],["Closer",2004,3.5,1,"Mike Nichols","Drama, Romance","fGGaokx4k00S0J603VG53Qlr9jz.jpg",2288],["Jacob's Ladder",1990,3,1,"Adrian Lyne","Drama, Mystery, Horror","ufLcHIi1aXjjH8MediAMvnwDsVI.jpg",2291],["Clerks",1994,2.5,1,"Kevin Smith","Comedy","9IiSgiq4h4siTIS9H3o4nZ3h5L9.jpg",2292],["Space Jam",1996,3,1,"Joe Pytka","Family, Animation, Science Fiction, Fantasy, Comedy","4RN5El3Pj2W4gpwgiAGLVfSJv2g.jpg",2300],["Beowulf",2007,2.5,1,"Robert Zemeckis","Adventure, Action, Animation","7QsWYyJAV97N9jOh21pdRIqJeJq.jpg",2310],["Married to the Mob",1988,2,1,"Jonathan Demme","Comedy, Crime, Romance","gkOsxv1RvV5smRnm6wrmn2wDXyZ.jpg",2321],["Field of Dreams",1989,2.5,1,"Phil Alden Robinson","Drama, Fantasy","oeM7nAw6FVFICwUaXKCRkDsKjqO.jpg",2323],["Westworld",1973,2.5,1,"Michael Crichton","Adventure, Science Fiction, Western","qNt29HzxwZ4jGTgSRxdA34ino9Q.jpg",2362],["The Young Girls of Rochefort",1967,3,1,"Jacques Demy","Romance, Comedy, Drama","jtxhyGaYhurH6KsjvP1jV3dDypz.jpg",2433],["Joint Security Area",2000,3.5,1,"Park Chan-wook","Drama, Thriller, Mystery","etoPOj0bXzfw0LBNslCxqO7MHuv.jpg",2440],["The Chronicles of Narnia: Prince Caspian",2008,2,1,"Andrew Adamson","Adventure, Family, Fantasy","qxz3WIyjZiSKUhaTIEJ3c1GcC9z.jpg",2454],["Tie Me Up! Tie Me Down!",1989,3,1,"Pedro Almodóvar","Comedy, Romance, Drama","4eNyqA543ixNCME8pcADgP9wb1i.jpg",2469],["Eragon",2006,1.5,1,"Stefen Fangmeier","Fantasy, Action, Adventure, Family","mNu6QLUnKqPIjRA3pgEb5dkJye6.jpg",2486],["The Princess Bride",1987,4,2,"Rob Reiner","Adventure, Fantasy, Romance, Family","2FC9L9MrjBoGHYjYZjdWQdopVYb.jpg",2493],["The Bourne Identity",2002,3.5,1,"Doug Liman","Action, Mystery, Thriller","aP8swke3gmowbkfZ6lmNidu0y9p.jpg",2501],["The Bourne Supremacy",2004,3.5,1,"Paul Greengrass","Action, Drama, Thriller","7IYGiDrquvX3q7e9PV6Pejs6b2g.jpg",2502],["The Bourne Ultimatum",2007,4,1,"Paul Greengrass","Action, Drama, Mystery, Thriller","15rMz5MRXFp7CP4VxhjYw4y0FUn.jpg",2503],["Nobody Knows",2004,4,1,"Hirokazu Kore-eda","Drama","kDUUdWrbBBVqzSmm27pHFJcTvCU.jpg",2517],["Joe Versus the Volcano",1990,2,1,"John Patrick Shanley","Comedy, Romance, Adventure","fwjMUuDZUxedfsUpVQKQN8cYfzB.jpg",2565],["The Aviator",2004,3.5,1,"Martin Scorsese","Drama","lx4kWcZc3o9PaNxlQpEJZM17XUI.jpg",2567],["Code 46",2003,2.5,1,"Michael Winterbottom","Drama, Science Fiction, Thriller","ijayvLrCAwOVizi9OY8LZWq5SRW.jpg",2577],["Planes, Trains and Automobiles",1987,2.5,1,"John Hughes","Comedy","fwi2cET87xArJCb8MdbWq2BZO3n.jpg",2609],["Splash",1984,2.5,1,"Ron Howard","Comedy, Romance, Fantasy","7FutTsMWBwVhjk1Ujf1wtndUVZh.jpg",2619],["An Officer and a Gentleman",1982,2,1,"Taylor Hackford","Drama, Romance","69adZbLeRk5TNQ3e0008dMnde9p.jpg",2623],["Deconstructing Harry",1997,3.5,1,"Woody Allen","Comedy, Drama","i7Z5DdznqANJUjqWISEFu9bw6J7.jpg",2639],["Heathers",1989,3,1,"Michael Lehmann","Comedy, Crime","dGbVfM4WlM7uvIbyRehfPZUIgp2.jpg",2640],["The Game",1997,3,1,"David Fincher","Drama, Thriller, Mystery","4UOa079915QjiTA2u5hT2yKVgUu.jpg",2649],["In the Mouth of Madness",1994,3.5,1,"John Carpenter","Horror, Mystery, Drama, Thriller, Fantasy","msh4tEUzbnEqlHcFOUH4O0Zti8r.jpg",2654],["Pleasantville",1998,4,1,"Gary Ross","Fantasy, Comedy, Drama","m1hhYP6OScjKU5Z9iZaWirSn4I6.jpg",2657],["Batman",1966,3,1,"Leslie H. Martinson","Action, Comedy, Crime","zzoPxWHnPa0eyfkMLgwbNvdEcVF.jpg",2661],["House of 1000 Corpses",2003,2.5,1,"Rob Zombie","Horror","29c2qgXmSREosLBevOILEuMWzQC.jpg",2662],["Dark City",1998,3,1,"Alex Proyas","Mystery, Science Fiction","tNPEGju4DpTdbhBphNmZoEi9Bd3.jpg",2666],["The Blair Witch Project",1999,3,1,"Daniel Myrick","Horror, Mystery","9050VGrYjYrEjpOvDZVAngLbg1f.jpg",2667],["Sleepy Hollow",1999,3.5,1,"Tim Burton","Fantasy, Thriller, Mystery, Horror","1GuK965FLJxqUw9fd1pmvjbFAlv.jpg",2668],["Ring",1998,3.5,1,"Hideo Nakata","Horror, Thriller","1YINof6kN5yRdePEbcU5360ejoq.jpg",2671],["Signs",2002,3,1,"M. Night Shyamalan","Thriller, Science Fiction, Horror","YtrIdrTxpRhvCnlw43dwOjfLqx.jpg",2675],["Irma la Douce",1963,2.5,1,"Billy Wilder","Romance, Comedy, Drama","5TgL8ql6WwXWmX4EvBL4geJ7gx5.jpg",2690],["Evan Almighty",2007,1,1,"Tom Shadyac","Fantasy, Comedy, Family","blI1ioXbgJWOJ3PbcBuSV65Ebwu.jpg",2698],["Z",1969,4,1,"Costa-Gavras","Thriller, Crime, Drama","dFAJyFNgvOv24f2RQyI9KDxjGr3.jpg",2721],["Naked Lunch",1991,3.5,1,"David Cronenberg","Crime, Drama","u01kh5jKUWjhom76mguRqUgdvja.jpg",2742],["Journey to Italy",1954,4,1,"Roberto Rossellini","Drama, Romance","tjli2Rjwkn8fivuynxwthnnEzeo.jpg",2748],["24 Hour Party People",2002,3.5,1,"Michael Winterbottom","Comedy, Drama, Music","8f50NQ1wz6hdxfCISCPV8XQ6DII.jpg",2750],["About Schmidt",2002,4.5,1,"Alexander Payne","Drama, Comedy","tstvsrJHY57hc951lb190alXRQm.jpg",2755],["The Abyss",1989,3.5,1,"James Cameron","Adventure, Thriller, Science Fiction","2dCit3XAtv9KWCJvRKdPkJ0FAkH.jpg",2756],["Adaptation.",2002,5,1,"Spike Jonze","Comedy, Crime, Drama","ffEmHQAiD0m5dEQ6rlsuA9vlllW.jpg",2757],["Addams Family Values",1993,3.5,1,"Barry Sonnenfeld","Comedy, Family, Fantasy","sdxT2VjVSx9DRicwnuECUdBHeE7.jpg",2758],["The Adventures of Priscilla, Queen of the Desert",1994,3.5,1,"Stephan Elliott","Drama, Comedy","kJ7syYXEJgSBmBfSnF3Can9cK1J.jpg",2759],["The Lovers on the Bridge",1991,4,1,"Leos Carax","Drama, Romance","un81oln6mAv66sqnkgPSpWONUqP.jpg",2767],["An American in Paris",1951,3.5,1,"Vincente Minnelli","Music, Romance, Comedy","lyDXkvG53ldz6Cf7dbjJl7TaoP5.jpg",2769],["American Splendor",2003,4,1,"Shari Springer Berman","Comedy, Drama","rPLMxuk82AiqDiwEUVJ6E7WpjYs.jpg",2771],["Pierrot le Fou",1965,3.5,1,"Jean-Luc Godard","Drama, Romance, Crime","i124H6iQB4CawrgFW9aZaZs7OBO.jpg",2786],["Pitch Black",2000,2.5,1,"David Twohy","Thriller, Science Fiction, Action","3AnlxZ5CZnhKKzjgFyY6EHxmOyl.jpg",2787],["Reality Bites",1994,3.5,1,"Ben Stiller","Drama, Romance, Comedy","qGDhodtpkpxkrFqokenGNJlzt6w.jpg",2788],["Identity",2003,2.5,1,"James Mangold","Mystery, Thriller","sYgimsiBywqVwJI8H4sETke8m7v.jpg",2832],["As Good as It Gets",1997,4,1,"James L. Brooks","Drama, Comedy, Romance","xXxuJPNUDZ0vjsAXca0O5p3leVB.jpg",2898],["The Addams Family",1991,3,1,"Barry Sonnenfeld","Comedy, Fantasy","qFf8anju5f2epI0my8RdwwIXFIP.jpg",2907],["Frankenstein (1910)",1910,2.5,1,"J. Searle Dawley","Horror, Science Fiction, Fantasy","xPzF7qW6FFZEzfsnsKqNOncxJNU.jpg",2929],["License to Wed",2007,1.5,1,"Ken Kwapis","Comedy","lJbT99nN3jEe23EfQvmlSh6EQ2b.jpg",2959],["The Impossible Voyage",1904,3,1,"Georges Méliès","Adventure, Comedy, Fantasy, Science Fiction","mnbGqzZ6bbgI3G1152HKCsJvXpf.jpg",2963],["The Golem: How He Came Into the World",1920,2.5,1,"Carl Boese","Fantasy, Horror","7zdqM0MgZBfy3tuJdNO4cWAGBtj.jpg",2972],["Hairspray (2007)",2007,3.5,1,"Adam Shankman","Comedy, Romance, Drama","fgMka3HtFvI5OgW1eYdR9XpySxH.jpg",2976],["Ghostbusters II",1989,2.5,1,"Ivan Reitman","Comedy, Fantasy","u7UioNGwAeWfYPv5pSAZSM0ipSt.jpg",2978],["Roar",1981,3,1,"Noel Marshall","Adventure, Comedy, Horror, Thriller","oN7FZe6qNAAb46MpgbIyua8fJy7.jpg",2989],["How to Steal a Million",1966,3.5,1,"William Wyler","Comedy, Crime, Romance","xaf3pwmITJvfz9Ab8DiGM8OOtBC.jpg",3001],["The Trial",1962,4.5,1,"Orson Welles","Crime, Drama, Mystery","4qDUe5HqB8pXNplSBlsoyVjNP3r.jpg",3009],["Gods and Monsters",1998,3.5,1,"Bill Condon","Drama","awvJH3NtXoStsjAtXKr99hfuVaG.jpg",3033],["Young Frankenstein",1974,4,1,"Mel Brooks","Comedy","3BvvVKPg9yucChlSvQtJxAbLmj9.jpg",3034],["Frankenstein",1931,4,1,"James Whale","Drama, Horror, Science Fiction","mu6wHwH0IwCCaEYtpqujuPJYat1.jpg",3035],["Mary Shelley's Frankenstein",1994,2.5,1,"Kenneth Branagh","Drama, Horror, Science Fiction, Romance","bOwCAQsZlEKrwhPi1ejY6BS8jpL.jpg",3036],["In Bed",2005,3,1,"Matías Bize","Romance, Drama, Comedy","nl1HMHXqsrTepnO33anCxGjLFxP.jpg",3041],["Ace Ventura: Pet Detective",1994,3,1,"Tom Shadyac","Comedy, Crime, Mystery","pqiRuETmuSybfnVZ7qyeoXhQyN1.jpg",3049],["Doctor Dolittle",1998,2,1,"Betty Thomas","Comedy, Family, Fantasy","tLrchGMIkdo1KamQJA6fwvDQEy0.jpg",3050],["Intolerance: Love's Struggle Throughout the Ages",1916,2.5,1,"D.W. Griffith","Drama, History","lJCabs4TMOsKfnl0BmA5Hf16Ezb.jpg",3059],["Duck Soup",1933,2,1,"Leo McCarey","Comedy, War","31t63plEGKHhYuuCpC9bFWO9SBS.jpg",3063],["Son of Frankenstein",1939,3,1,"Rowland V. Lee","Horror, Science Fiction","oefhX4T3iWo2XFvaOunR7azWAo3.jpg",3077],["It Happened One Night",1934,4,1,"Frank Capra","Comedy, Romance","2PNUGWAflH6UUumas0POMmokHlc.jpg",3078],["The Curse of Frankenstein",1957,3,1,"Terence Fisher","Horror, Science Fiction","r9PDkqKhzdo54aqnOL88wUJY49B.jpg",3079],["Top Hat",1935,3,1,"Mark Sandrich","Music, Comedy, Romance","qoPBiN6PBs2NsP7BNOJGCnmwruG.jpg",3080],["Modern Times",1936,5,2,"Charlie Chaplin","Comedy, Drama, Romance","7uoiKOEjxBBW0AgDGQWrlfGQ90w.jpg",3082],["Mr. Smith Goes to Washington",1939,3,1,"Frank Capra","Comedy, Drama","nDjg1fbNyq15excNDl3acd2IqAk.jpg",3083],["His Girl Friday",1940,2.5,1,"Howard Hawks","Comedy, Romance, Drama","fmQLvnDEL9wlE6FzB1S84yskdkT.jpg",3085],["The Lady Eve",1941,2,1,"Preston Sturges","Comedy, Romance","lJYD3CMgKtv12hazSHc7xt3i2uq.jpg",3086],["Yankee Doodle Dandy",1942,2.5,1,"Michael Curtiz","Drama, Music","cqLLIyJFjLr6jGOxWVEHG11WGzB.jpg",3087],["My Darling Clementine",1946,4,1,"John Ford","Western, Drama, Romance, History","o7G5klSt9i8LQZdUNvrWUJbbxAO.jpg",3088],["Red River",1948,4,1,"Howard Hawks","Western","jyNTsAzrIWB441OtvfbgKtx1kFS.jpg",3089],["The Treasure of the Sierra Madre",1948,3.5,1,"John Huston","Adventure, Drama, Western","pWcst7zVbi8Z8W6GFrdNE7HHRxL.jpg",3090],["Destroy All Monsters",1968,2.5,1,"Ishirō Honda","Science Fiction, Action","24r1hsRisfUidwLF67J0iMuWh7p.jpg",3107],["The Quiet Man",1952,2.5,1,"John Ford","Romance, Comedy, Drama","u3B1hVKHE56yBRoxF3Nk9uxHdYN.jpg",3109],["Shane",1953,3,1,"George Stevens","Drama, Western","svr5ADpjXTCOQv8hmuJnB7I14Qv.jpg",3110],["A Star Is Born",1954,3.5,1,"George Cukor","Drama, Music, Romance","zpg2SzpYhZk1D1seDfIIlwaqAxT.jpg",3111],["The Night of the Hunter",1955,4,1,"Charles Laughton","Crime, Drama, Thriller","rBka0nFWiHxabHRLr0KfIA8Yiaq.jpg",3112],["The Searchers",1956,4,1,"John Ford","Western","jLBmgW0epNzJ1N9uzaVCjbyT94v.jpg",3114],["Midnight Cowboy",1969,4,1,"John Schlesinger","Drama","ckklq45UxUkwgHve9xItXqXr06r.jpg",3116],["Nashville",1975,4,1,"Robert Altman","Drama, Comedy, Music","twl4ovyjb8muFKvZmcCDzPR0hy1.jpg",3121],["Alvin and the Chipmunks Meet Frankenstein",1999,1.5,1,"Kathi Castillo","Animation, Comedy, Family","hiXOFmWtxQ3LdrGgP2uOuR1DHBp.jpg",3126],["Gangs of New York",2002,3.5,1,"Martin Scorsese","Drama, History, Crime","lemqKtcCuAano5aqrzxYiKC8kkn.jpg",3131],["Badlands",1973,4,1,"Terrence Malick","Crime, Drama, Romance","z81rBzHNgiNLean2JTGHgxjJ8nq.jpg",3133],["Bambi",1942,3.5,1,"David Hand","Animation, Drama, Family","wV9e2y4myJ4KMFsyFfWYcUOawyK.jpg",3170],["Barry Lyndon",1975,5,1,"Stanley Kubrick","Drama, War, History","lTql1DBlPxY2cV5cMsjUrV9MdeB.jpg",3175],["Battle Royale",2000,3,1,"Kinji Fukasaku","Drama, Thriller, Action","gFX7NuBUeKysOB9nEzRqVpHNT32.jpg",3176],["Good Night, and Good Luck.",2005,4,1,"George Clooney","Drama, History","w4QSEno2xxHqMtSr3mPUhJpO3F2.jpg",3291],["Mildred Pierce",1945,4,1,"Michael Curtiz","Crime, Drama","3bqF5bJPjeITNeC8ydbUOQZfuqP.jpg",3309],["A Scanner Darkly",2006,4,1,"Richard Linklater","Animation, Science Fiction, Thriller","lUKudOpHICDj6A6SO7DdaZM4W48.jpg",3509],["Working Girl",1988,3.5,1,"Mike Nichols","Comedy, Romance, Drama","q2jfFzZvAzjTaArQR0tjilIZ5aJ.jpg",3525],["The Thin Man",1934,3,1,"W.S. Van Dyke","Comedy, Mystery, Crime","6cL89ok9t8xEKboOjOVga2W66jj.jpg",3529],["Girl, Interrupted",1999,3,1,"James Mangold","Drama","dOBdatHIVppvmRFw2z7bf9VKJr9.jpg",3558],["I Now Pronounce You Chuck & Larry",2007,1.5,1,"Dennis Dugan","Comedy, Romance","vF0yEaGyXYsHWRTMmeJaJKp43bj.jpg",3563],["Changeling",2008,3,1,"Clint Eastwood","Crime, Drama, Mystery","y9Qi39dL3PceGCH8afyC7QrhbhI.jpg",3580],["I Know What You Did Last Summer",1997,2.5,1,"Jim Gillespie","Horror, Thriller, Mystery","dQyaJx0SptDqvQcAewAr8FAtLB2.jpg",3597],["I Still Know What You Did Last Summer",1998,1.5,1,"Danny Cannon","Horror, Mystery, Thriller","eg3d6hvTaOmW3lNErFfutBmWmAR.jpg",3600],["Flash Gordon",1980,2,1,"Mike Hodges","Science Fiction, Adventure, Action","eTdEaRjtVnFbd5KVhxLRfbYW46e.jpg",3604],["Flags of Our Fathers",2006,3,1,"Clint Eastwood","War, Drama, History","2nkPrhf4YIyMFelfe4zdOnGRYz5.jpg",3683],["The Lady from Shanghai",1947,4,1,"Orson Welles","Mystery, Crime, Thriller, Drama","whqdqWavNMSoeXTx1X3DauO1LG6.jpg",3766],["Gilda",1946,2.5,1,"Charles Vidor","Romance, Drama, Thriller","46eKPjoWEyNBAQKDoXEcDFBcaUw.jpg",3767],["Throne of Blood",1957,4,1,"Akira Kurosawa","History, Drama","zaZFMNxJST0TtPd68yF7fNt1he8.jpg",3777],["Red Beard",1965,3.5,1,"Akira Kurosawa","Drama","iYNH3Re0JSypoYaWvZtERUnNaJL.jpg",3780],["Ikiru",1952,4.5,1,"Akira Kurosawa","Drama","dgNTS4EQDDVfkzJI5msKuHu2Ei3.jpg",3782],["Frankie and Johnny",1991,3.5,1,"Garry Marshall","Drama, Romance, Comedy","zSOh7hriX4mQNVxhCz1yVY4aykn.jpg",3784],["I'm Not There",2007,3.5,1,"Todd Haynes","Drama, Music","bucgvB7gQqcl1m71efHkenfIMTj.jpg",3902],["Corpse Bride",2005,3.5,1,"Tim Burton","Romance, Fantasy, Animation","isb2Qow76GpqYmsSyfdMfsYAjts.jpg",3933],["Team America: World Police",2004,2.5,1,"Trey Parker","Adventure, Action, Comedy","m1Q2VFe1DVVbjfu1LDZe7tlp9yb.jpg",3989],["Beetlejuice",1988,4,3,"Tim Burton","Fantasy, Comedy","nnl6OWkyPpuMm595hmAxNW3rZFn.jpg",4011],["Last Year at Marienbad",1961,2.5,1,"Alain Resnais","Drama, Romance","syIJCqiSkGRJTlyaBtyI5jqPtE7.jpg",4024],["My Girl",1991,3.5,1,"Howard Zieff","Comedy, Drama","qyJJNHteA7BUwQSey05t7qP4vRV.jpg",4032],["Law of Desire",1987,3.5,1,"Pedro Almodóvar","Drama, Romance, Thriller, Comedy","tAKaUaYGPCUStvlOaLwsJldrOJQ.jpg",4043],["Black Rain",1989,2.5,1,"Ridley Scott","Drama, Action, Thriller","funhGWt9ee3Uwb6Ar8SGCCvbJdV.jpg",4105],["The Transporter",2002,2.5,1,"Louis Leterrier","Action, Crime, Thriller","dncJ81z1BahrT3ogLvlxOUC5n4u.jpg",4108],["Blow",2001,3.5,1,"Ted Demme","Crime, Drama","yYZFVfk8aeMP4GxBSU9MTvqs9mJ.jpg",4133],["Road to Perdition",2002,4.5,2,"Sam Mendes","Crime, Drama, Thriller","loSpBeirRfTPJ3cMIqpQArstGhh.jpg",4147],["Revolutionary Road",2008,4,1,"Sam Mendes","Drama, Romance","cvkD3yiVXLg3as8EAG3LaTycONQ.jpg",4148],["Stromboli",1950,3,1,"Roberto Rossellini","Drama","tsyyzGSspKsawHocchfokskwbeM.jpg",4173],["Spellbound",1945,3,1,"Alfred Hitchcock","Thriller, Mystery, Romance","dPAox7jGScLBvxKLeRptJIBF7v.jpg",4174],["Murder on the Orient Express",1974,2.5,1,"Sidney Lumet","Drama, Thriller, Mystery","x7E9iNMi5iFTdUNJvEZ1x8YNEZ2.jpg",4176],["Women on the Verge of a Nervous Breakdown",1988,4.5,3,"Pedro Almodóvar","Comedy, Drama","8C5FJlUo96pj1xAs2BKnB58PYzi.jpg",4203],["Scream",1996,4,1,"Wes Craven","Crime, Horror, Mystery","lr9ZIrmuwVmZhpZuTCW8D9g0ZJe.jpg",4232],["Scream 2",1997,3.5,1,"Wes Craven","Horror, Mystery","dORlVasiaDkJXTqt9bdH7nFNs6C.jpg",4233],["Scream 3",2000,3,1,"Wes Craven","Horror, Mystery","qpH8ToZVlFD1bakL04LkEKodyDI.jpg",4234],["Visitor Q",2001,2,1,"Takashi Miike","Comedy, Drama, Horror, Thriller","yLepVO6sblNt4elcug5PUxpW6ou.jpg",4241],["The Kid (2000)",2000,2,1,"Jon Turteltaub","Fantasy, Comedy, Family","",4244],["Scary Movie",2000,2,1,"Keenen Ivory Wayans","Comedy","fVQFPRuw3yWXojYDJvA5EoFjUOY.jpg",4247],["Scary Movie 2",2001,2,1,"Keenen Ivory Wayans","Comedy","7Eb1JWK0Cb0rbfsYjwfc9g0PbQH.jpg",4248],["Scary Movie 3",2003,1.5,1,"Jerry Zucker & David Zucker & Jim Abrahams","Comedy","lpNG1nx67rvYze1b1R9q0YoSzrC.jpg",4256],["Scary Movie 4",2006,1,1,"Jerry Zucker & David Zucker & Jim Abrahams","Comedy","dEwlu8S0z1AibuX1weLwUyiRWFl.jpg",4257],["The Flower of My Secret",1995,3,1,"Pedro Almodóvar","Drama, Romance","u172NHV9SvqgVDSyRayJIPK2Brl.jpg",4307],["Charlie's Angels",2000,2.5,1,"McG","Action, Comedy, Adventure","iHTmZs0BmkwMCYi8rhvMWC5G4EM.jpg",4327],["Atonement",2007,4,1,"Joe Wright","Drama, Romance","hMRIyBjPzxaSXWM06se3OcNjIQa.jpg",4347],["Pride & Prejudice",2005,4,1,"Joe Wright","Drama, Romance","o8UhmEbWPHmTUxP0lMuCoqNkbB3.jpg",4348],["Les Misérables (1998)",1998,2.5,1,"Bille August","Crime, Drama, History, Romance","3TOgmlIY8X3WjIjvU7Z0jqeNkyU.jpg",4415],["2010: The Year We Make Contact",1984,2,1,"Peter Hyams","Thriller, Science Fiction","mEWKXuCMv7mFMxXVSTI3v8UOQuq.jpg",4437],["The Brothers Grimm",2005,2,1,"Terry Gilliam","Adventure, Fantasy, Action, Comedy, Thriller","iPrey2UYrA5Fqa8L3KnxqMqfmSq.jpg",4442],["The Fall",2019,4,1,"Jonathan Glazer","Drama, Western, Romance, War","t1KPGlW0UGd0m515LPQmk2F4nu1.jpg",4476],["Friday the 13th",1980,1.5,1,"Sean S. Cunningham","Horror","uGGpnWHOmWTARVN9wbC1nPxNgps.jpg",4488],["The Spirit of the Beehive",1973,5,3,"Víctor Erice","Drama, Fantasy","6XYz70apXouklZioEKBgO3Xf0OK.jpg",4495],["Viridiana",1961,4,1,"Luis Buñuel","Drama","mYPuSx5JwL8AdTwS1iQW4Un1cYP.jpg",4497],["The Executioner",1963,4,1,"Luis García Berlanga","Comedy, Drama","z7U7XZWeRmsxqMtVahHHYQYIxlY.jpg",4498],["Pepi, Luci, Bom",1980,2.5,1,"Pedro Almodóvar","Comedy, Drama","xL72JwMDJLGZBUtXgjx7eERJ8nj.jpg",4499],["The Assassination of Jesse James by the Coward Robert Ford",2007,4,1,"Andrew Dominik","Drama, Western","xMKn6EQS7eR5ubhPJbw5pQSBZMw.jpg",4512],["Elizabeth",1998,3,1,"Shekhar Kapur","Drama, History","qEk48VLOdibXFVIEzE9ETZUBcCs.jpg",4518],["Enchanted",2007,3,1,"Kevin Lima","Comedy, Family, Fantasy, Romance","8KCNzCArLlvLdQoHx6npua2VSVc.jpg",4523],["The Darjeeling Limited",2007,3,1,"Wes Anderson","Adventure, Drama, Comedy","oSW5OVXTulaIXcoNwJAp5YEKpbP.jpg",4538],["Hearts of Darkness: A Filmmaker's Apocalypse",1991,4,1,"George Hickenlooper","Documentary","nVMCtL3r2nj4fySihDDvamaVkfx.jpg",4539],["Monty Python's The Meaning of Life",1983,3.5,1,"Terry Jones","Comedy","9yavZ9WgEZIpWi2EbVW8At9RPdo.jpg",4543],["Panic Room",2002,3.5,1,"David Fincher","Crime, Drama, Thriller","hANYbvfwxmkC9E4yY6YyJxYxlSJ.jpg",4547],["Lady Vengeance",2005,5,1,"Park Chan-wook","Drama, Thriller","3Oy3iLMqD79us2iAUD6fKqWebYU.jpg",4550],["A Tale of Two Sisters",2003,2.5,1,"Kim Jee-woon","Drama, Horror, Mystery","l3exwhwyGE0NnHJ3lFQ7eXoBSkH.jpg",4552],["The Machinist",2004,3.5,1,"Brad Anderson","Thriller, Drama","diAYqR4xdF9Hnj7qun6DEQhRrT2.jpg",4553],["Orpheus",1950,4,1,"Jean Cocteau","Romance, Fantasy, Drama","wcUmMtipWBBx7lpsfpPsUM4Snh1.jpg",4558],["Sense and Sensibility",1995,4,1,"Ang Lee","Drama, Romance","cBK2yL3HqhFvIVd7lLtazWlRZPR.jpg",4584],["The Discreet Charm of the Bourgeoisie",1972,3.5,1,"Luis Buñuel","Comedy","zN4ILX2x64PvT2jIOAHXxCOi5WA.jpg",4593],["Hot Fuzz",2007,4.5,3,"Edgar Wright","Crime, Action, Comedy","zPib4ukTSdXvHP9pxGkFCe34f3y.jpg",4638],["Across the Universe",2007,2.5,1,"Julie Taymor","Drama, Romance, Fantasy","447c8Te3DXC46rQvDEixKGO4dS6.jpg",4688],["Sympathy for Mr. Vengeance",2002,4.5,1,"Park Chan-wook","Action, Drama, Thriller","uj42ubGbgVL65T10SvPVr0p9mJc.jpg",4689],["Southland Tales",2006,1.5,1,"Richard Kelly","Science Fiction, Thriller, Comedy","7dbIDQ80z4bxiDlAvxRwc5TI44C.jpg",4723],["Gone Baby Gone",2007,3.5,1,"Ben Affleck","Crime, Drama, Mystery","wZR1dvctqODqNGv6LJBEj6DQ2zK.jpg",4771],["Cassandra's Dream",2007,2.5,1,"Woody Allen","Crime, Drama, Thriller","rZLKa5mXJzfmJsC9DFNkcpZ5vS0.jpg",4787],["Charade",1963,4,1,"Stanley Donen","Comedy, Mystery, Romance","qqaPjC5FQidtKY65jbAKZPiOTaS.jpg",4808],["Ghost Dog: The Way of the Samurai",1999,4,1,"Jim Jarmusch","Crime, Drama","gkH4zOxIfbb4BEbk9Q4cVOEpDaY.jpg",4816],["Guys and Dolls",1955,2,1,"Joseph L. Mankiewicz","Comedy, Crime, Romance","mrSM6laJJLBVdMdWfeNRa1innnk.jpg",4825],["Layer Cake",2004,3.5,1,"Matthew Vaughn","Drama, Thriller, Crime","rDOxXteqxALBaSa3V3zTjGJuyWB.jpg",4836],["Confessions of a Dangerous Mind",2002,3,1,"George Clooney","Comedy, Crime, Drama, Romance, Thriller, History","nccluUFM3pRNI9nUyDEcDa6KviO.jpg",4912],["The Curious Case of Benjamin Button",2008,3,1,"David Fincher","Drama, Fantasy, Romance","26wEWZYt6yJkwRVkjcbwJEFh9IS.jpg",4922],["Howl's Moving Castle",2004,5,3,"Hayao Miyazaki","Fantasy, Animation, Adventure","13kOl2v0nD2OLbVSHnHk8GUFEhO.jpg",4935],["Burn After Reading",2008,4,1,"Joel Coen & Ethan Coen","Comedy, Drama","jdwSkQu3XirmX18MNj8CqFWsCk.jpg",4944],["10 Things I Hate About You",1999,3,1,"Gil Junger","Comedy, Romance, Drama","ujERk3aKABXU3NDXOAxEQYTHe9A.jpg",4951],["Be Kind Rewind",2008,3.5,1,"Michel Gondry","Drama, Comedy","f0oX20YrQEiVPDH9InCQ1d3Cm66.jpg",4953],["Synecdoche, New York",2008,5,3,"Charlie Kaufman","Drama","5UwdhrjXhUgsiDhe1dpS9z4yj7q.jpg",4960],["Knocked Up",2007,2,1,"Judd Apatow","Comedy, Romance, Drama","b4OaXw2MW97VvIiZE0Sbn1NfxSh.jpg",4964],["Paprika",2006,4.5,1,"Satoshi Kon","Animation, Science Fiction, Thriller","bLUUr474Go1DfeN1HLjE3rnZXBq.jpg",4977],["An American Tail",1986,3,1,"Don Bluth","Adventure, Animation, Comedy, Drama, Family","wjhUy9af89vc9CviKcPgTNTrmIq.jpg",4978],["American Gangster",2007,3.5,1,"Ridley Scott","Drama, Crime","m7kJge9DG86Bj7hsBW6xFCMyDkY.jpg",4982],["Boogie Nights",1997,5,5,"Paul Thomas Anderson","Drama, Comedy","wnE24UPCPQsQnbBOu4zVE2qaDNm.jpg",4995],["Vicky Cristina Barcelona",2008,3.5,1,"Woody Allen","Drama, Romance","ekAIg0GSbbHTH7y1GPgWj0brLTW.jpg",5038],["Ashes and Diamonds",1958,3.5,1,"Andrzej Wajda","Drama, War, Romance","nE8aqRvVnRQEqskiarnFhdJdk8g.jpg",5055],["Hannah and Her Sisters",1986,3.5,1,"Woody Allen","Comedy, Drama","gARgIRb2QFRFVrsziwWE389u1pK.jpg",5143],["Bicycle Thieves",1948,5,2,"Vittorio De Sica","Drama","iPdVqIpmR3bRvOQJPrn4pr2KR3q.jpg",5156],["L'Avventura",1960,3,1,"Michelangelo Antonioni","Drama, Mystery, Romance","7kUXAS8K7Ihw1T1mhARjnLuMVk3.jpg",5165],["Rush Hour 3",2007,2,1,"Brett Ratner","Action, Comedy, Crime","mp9CzKxLa2i7yblMXUrzVfGqsCo.jpg",5174],["Rush Hour 2",2001,2.5,1,"Brett Ratner","Action, Comedy, Crime","aBQf2vMiCINeVC9v6BGVYKXurTh.jpg",5175],["3:10 to Yuma",2007,3.5,1,"James Mangold","Western","voMB69AsLnPNmtfbrBl0lbeFKDH.jpg",5176],["Pumping Iron",1977,3,1,"George Butler","Documentary","24bh2SaydGoP9Jsi7eP2TkWGkLd.jpg",5205],["Kiss Kiss Bang Bang",2005,3.5,1,"Shane Black","Comedy, Crime, Mystery, Thriller","aWfjIkpENFX6Uw82pET7EQ6jnrd.jpg",5236],["The Polar Express",2004,2.5,1,"Robert Zemeckis","Adventure, Animation, Family, Fantasy","eOoCzH0MqeGr2taUZO4SwG416PF.jpg",5255],["Gosford Park",2001,3.5,1,"Robert Altman","Drama, Mystery, Thriller","mQlmUTLxFG5irSVHlvIxRHCCjKf.jpg",5279],["Salò, or the 120 Days of Sodom",1975,3,1,"Pier Paolo Pasolini","Horror, Drama","xnaDdiRfZlJaTf6JRc4in40eaeI.jpg",5336],["I'm a Cyborg, But That's OK",2006,2.5,1,"Park Chan-wook","Drama, Comedy, Romance","9uDGx2lzjROf3335CGKdCYs6WD5.jpg",5488],["Battlefield Earth",2000,0.5,1,"Roger Christian","Science Fiction, Action, Adventure","wXCRuBHdJ5aTFQdsuGJFXNdo79T.jpg",5491],["The Fugitive",1993,3.5,1,"Andrew Davis","Action, Thriller, Drama","b3rEtLKyOnF89mcK75GXDXdmOEf.jpg",5503],["The Ladykillers",1955,3,1,"Alexander Mackendrick","Comedy, Crime","9LJ6ZV59Q92LAJAbmb7xm9dUBGU.jpg",5506],["Le Samouraï",1967,3,1,"Jean-Pierre Melville","Crime, Thriller, Drama","5Fa6o5nfUPEatQ9b3OwEvdEdR7T.jpg",5511],["The Ladykillers (2004)",2004,3,2,"Joel Coen & Ethan Coen","Comedy, Crime, Thriller","l4g9R39NCp6VaYFrw6q8JwKNW9x.jpg",5516],["The Chorus",2004,3,1,"Christophe Barratier","Drama, Comedy, Music","hUl7gSvkGygyk9wt3zy5NqpC5bb.jpg",5528],["Hiroshima Mon Amour",1959,4,1,"Alain Resnais","Drama, History, Romance","zieczjWnvalaxwX5EQASEx0on5f.jpg",5544],["RoboCop",1987,3.5,1,"Paul Verhoeven","Action, Thriller, Science Fiction","esmAU0fCO28FbS6bUBKLAzJrohZ.jpg",5548],["RoboCop 2",1990,2,1,"Irvin Kershner","Action, Science Fiction, Thriller","nhqBxhOJXUJeFsyLxTFkctH9H5F.jpg",5549],["Bee Movie",2007,1.5,1,"Simon J. Smith","Family, Animation, Adventure, Comedy","aWe27GmvfVYAd7p0KEtJZWwLWk5.jpg",5559],["Donkey Skin",1970,3.5,1,"Jacques Demy","Fantasy, Comedy, Music, Romance","47ZTJNco6BAIKlL1fixsqyJhb55.jpg",5590],["Pee-wee's Big Adventure",1985,3,1,"Tim Burton","Comedy, Adventure, Family","414IUXc54mrhX88ZUQiRDLXn01i.jpg",5683],["The Blue Lagoon",1980,2,1,"Randal Kleiser","Adventure, Drama, Romance","k6KsThCeoxxHDbVnlHLdTlf5wsy.jpg",5689],["The Great Train Robbery",1903,3,1,"Edwin S. Porter","Western, Crime, Action, Adventure","vEYr1sJR1dOFGXwXawpBN6hDRGF.jpg",5698],["Once",2007,4.5,2,"John Carney","Drama, Music, Romance","7nW363kSYRCkr4VGOMvuSGwtzKs.jpg",5723],["L'Âge d'or",1930,3,1,"Luis Buñuel","Romance, Comedy, Drama","q3OH9Yk3hOE5uYEK55ASjEtsPfE.jpg",5729],["Two for the Road",1967,4.5,1,"Stanley Donen","Drama, Romance, Comedy","f9GAaL5gXzSP8LhXJcAx8Remfy3.jpg",5767],["Torn Curtain",1966,2.5,1,"Alfred Hitchcock","Thriller","7XC1l9eP2TBYMEdA4KRUqKAFmbm.jpg",5780],["That Obscure Object of Desire",1977,4,1,"Luis Buñuel","Comedy, Drama, Romance","9iUdC4dftkjYSBUJq5DAxC6WqB9.jpg",5781],["Pather Panchali",1955,4,1,"Satyajit Ray","Drama, History","frZj5djlU9hFEjMcL21RJZVuG5O.jpg",5801],["National Lampoon's Christmas Vacation",1989,2.5,1,"Jeremiah S. Chechik","Comedy","oat42hUw8XzKYUmfy0YLAxYd484.jpg",5825],["Showtime",2002,1.5,1,"Tom Dey","Action, Comedy","8sIooUxXZo2blCVuAYbL2wkdUfD.jpg",5851],["The Mist",2007,3.5,1,"Frank Darabont","Horror, Science Fiction, Thriller","1CvJ6diBACKPVGOpcWuY4XPQdqX.jpg",5876],["Fireworks",1997,4.5,1,"Takeshi Kitano","Crime, Drama","bWIo1nDJnSyGJvVt8bRw8PHBqo4.jpg",5910],["Into the Wild",2007,4,2,"Sean Penn","Adventure, Drama","jnLnLYP5pGDfri04gxtAqAvkHMw.jpg",5915],["Papillon",1973,4,1,"Franklin J. Schaffner","Crime, Drama","356oqQpug682OERsWV0bGZ0YxwQ.jpg",5924],["The Great Escape",1963,4,1,"John Sturges","Adventure, Drama, War","gBH4H8UMFxl139HaLz6lRuvsel8.jpg",5925],["Fanny and Alexander",1982,4.5,1,"Ingmar Bergman","Fantasy, Drama, Mystery","q8jlA3Wc1Z987hNKRFA44g5OugC.jpg",5961],["Along Came Polly",2004,2,1,"John Hamburg","Comedy, Romance","7Tp16THdpHkMrqgoiDresDz9CWL.jpg",5966],["The Umbrellas of Cherbourg",1964,3.5,2,"Jacques Demy","Drama, Romance","tAgTf64XKK5ir7w5C7dnB53jWWG.jpg",5967],["The Last Laugh",1924,4,1,"F. W. Murnau","Drama","7Y6Dxr3oYt1w7ew70YNdLLDYEjk.jpg",5991],["The Family Man",2000,2,1,"Brett Ratner","Comedy, Drama, Romance, Fantasy","9wToOVsKuf0XeKhlauzCa3D8Gui.jpg",5994],["Shanghai Knights",2003,2.5,1,"David Dobkin","Adventure, Comedy, Western","vVNQStMlZS9mn2AKBEpadRunHgt.jpg",6038],["The Witches of Eastwick",1987,3,1,"George Miller","Comedy, Fantasy, Horror","p5OivnZuXfy5E3BKKFIeSidmwys.jpg",6069],["Carlito's Way",1993,4,1,"Brian De Palma","Crime, Drama, Thriller","g6D7mjQtndu768cusGmoEQY9fTB.jpg",6075],["Bram Stoker's Dracula",1992,3,1,"Francis Ford Coppola","Romance, Horror","n39glC4GkBeCbwdenES8ZBodim8.jpg",6114],["Dinner for One",1963,2.5,1,"Heinz Dunkhase","Comedy","7WucEa0QFwAtv61wQ7X1Pyg2uAe.jpg",6166],["Cat People (1982)",1982,3,1,"Paul Schrader","Fantasy, Horror","nYcQnkbTD4LDmp11HCReQuUoMKD.jpg",6217],["Sister Act 2: Back in the Habit",1993,2.5,1,"Bill Duke","Music, Comedy","2jmPYqep3r2eumauyTauNIhSmR7.jpg",6279],["Junior",1994,2,1,"Ivan Reitman","Comedy, Science Fiction","swxxtzYc60qqnFhfWMFdmx9QXvY.jpg",6280],["MouseHunt",1997,2.5,1,"Gore Verbinski","Comedy, Family","aqBPrWOzXEO3rWEk3DYTHBjXNZb.jpg",6283],["Nosferatu the Vampyre",1979,4,1,"Werner Herzog","Drama, Horror","jHKzGYwf7P34vz8MhJBTN6cnaYD.jpg",6404],["Hotel Chevalier",2007,3,1,"Wes Anderson","Drama, Romance","fiWLuGIUAcJtu2hs7KlcZ0O2Ix3.jpg",6418],["The Jerk",1979,2.5,1,"Carl Reiner","Comedy","mIjOWtUofyt9Jawge7FbvITjU3D.jpg",6471],["Alvin and the Chipmunks",2007,1,1,"Tim Hill","Comedy, Family, Fantasy, Animation","3s3WvpKPXXeKAPketDDqiQTi20S.jpg",6477],["I Am Legend",2007,2.5,1,"Francis Lawrence","Drama, Science Fiction, Thriller","iPDkaSdKk2jRLTM65UOEoKtsIZ8.jpg",6479],["The Dukes of Hazzard",2005,1,1,"Jay Chandrasekhar","Comedy, Adventure, Action","2ZrNyYJEgE0VIqhelQPqFTR20xF.jpg",6519],["Life (1999)",1999,1.5,1,"Ted Demme","Comedy, Crime","saWYpX3ADdmdByQZVrSYUNbQ9GC.jpg",6522],["Charlie Wilson's War",2007,2.5,1,"Mike Nichols","Comedy, Drama, History","45FghqcdSYRWK7PsHUInaFPNd8l.jpg",6538],["Walk Hard: The Dewey Cox Story",2007,3.5,1,"Jake Kasdan","Comedy, Music","Aa1IQ4Cuin3d7qIahvPheMmR4E5.jpg",6575],["Underdog",2007,1,1,"Frederik Du Chau","Family, Action, Adventure, Comedy, Fantasy, Science Fiction","q5yoIlzQ3m7b3a0zLCf3NjsOvB8.jpg",6589],["Lars and the Real Girl",2007,4,1,"Craig Gillespie","Drama, Romance","nkAt4a7KIPc7Fi1BhxNHhYYbe2b.jpg",6615],["Death in Venice",1971,3.5,1,"Luchino Visconti","Drama","s81SuFBSqY8T5Lrn5R8ucX8LKxi.jpg",6619],["Sabrina",1954,3.5,2,"Billy Wilder","Comedy, Romance, Drama","e1Po9NDrH7IJZhv89467gJH5FS0.jpg",6620],["National Treasure: Book of Secrets",2007,2,1,"Jon Turteltaub","Action, Adventure, Mystery","xxoIBbvmTj1ZttzV439jAvoovTw.jpg",6637],["Zathura: A Space Adventure",2005,2.5,1,"Jon Favreau","Science Fiction, Adventure, Family","gDb5BW2NLqZ9cvg9nyzkZVvmgze.jpg",6795],["The Ten Commandments",1956,3.5,1,"Cecil B. DeMille","Drama, History","3Ei59AR64x6dMZfWobPCkZjbqTL.jpg",6844],["The Village",2004,3,1,"M. Night Shyamalan","Drama, Mystery, Thriller","v7UvYtKfIVaHLaHwVgfalyrK7Ho.jpg",6947],["What's Up, Doc?",1972,2.5,1,"Peter Bogdanovich","Comedy, Crime, Romance","d5WwZxneeAH2Kj2SeDV6oUY2oW0.jpg",6949],["The 40 Year Old Virgin",2005,3,1,"Judd Apatow","Comedy, Romance","mVeoqL37gzhMXQVpONi9DGOQ3tZ.jpg",6957],["Something's Gotta Give",2003,3,1,"Nancy Meyers","Drama, Comedy, Romance","1cpdqe0SpiHzzbOLq9GDUUlZdSl.jpg",6964],["No Country for Old Men",2007,5,2,"Joel Coen & Ethan Coen","Crime, Thriller, Western","6d5XOczc226jECq0LIX0siKtgHR.jpg",6977],["Big Trouble in Little China",1986,3,1,"John Carpenter","Action, Adventure, Comedy, Fantasy","gI2Qs1yTTj3NcESJyttCkbmJ4k9.jpg",6978],["Vampire's Kiss",1988,4,1,"Robert Bierman","Comedy, Horror, Fantasy","bEwvlXvvrVLPFwCOND5E38qly01.jpg",7091],["Jack",1996,1.5,1,"Francis Ford Coppola","Comedy, Family, Drama","9ZklgGqTljzg9VxzumbVOC1UKAs.jpg",7095],["Van Helsing",2004,3,1,"Stephen Sommers","Horror, Adventure, Action","gsFun8nATm52aGHeT8ueAel98nE.jpg",7131],["Cloverfield",2008,2.5,1,"Matt Reeves","Action, Thriller, Science Fiction","qIegUGJqyMMCRjkKV1s7A9MqdJ8.jpg",7191],["Futurama: Bender's Big Score",2007,3.5,1,"Dwayne Carey-Hill","Animation, Comedy, Science Fiction, Romance","bmVE90IHvx4uXQgtbRtu4RyMWpt.jpg",7249],["The Man Without a Past",2002,3,1,"Aki Kaurismäki","Comedy, Drama, Romance","9tBepCujkyNg1qM52MsaJfDkIRw.jpg",7294],["Equilibrium",2002,2.5,1,"Kurt Wimmer","Action, Science Fiction, Thriller","q6VzUsHs4Z3myBHkrPAA3avfGwn.jpg",7299],["Maid in Manhattan",2002,1,1,"Wayne Wang","Comedy, Drama, Romance","gnEuTYH3jhHxl80QyoPfZjEYd0J.jpg",7303],["Juno",2007,4,1,"Jason Reitman","Comedy, Drama, Romance","jNIn2tVhpvFD6P9IojldI3mNYcn.jpg",7326],["Carrie",1976,4,1,"Brian De Palma","Horror, Thriller","8tT1rqlsTguyfUBMrbHR9cv1rxM.jpg",7340],["Carrie (2002)",2002,2,1,"David Carson","Horror, TV Movie, Thriller","knjeEeeyIwDkUtZwDfJOcUIuNdB.jpg",7342],["There Will Be Blood",2007,5,3,"Paul Thomas Anderson","Drama","fa0RDkAlCec0STeMNAhPaF89q6U.jpg",7345],["Elite Squad",2007,3.5,1,"José Padilha","Drama, Action, Crime","lwIXz785N2fXi8hsBr1IXciFlkM.jpg",7347],["The Bucket List",2007,2.5,1,"Rob Reiner","Drama, Comedy","idbNSe8zsYKQL97dJApfOrDSdya.jpg",7350],["Chicken Run",2000,4,1,"Nick Park","Animation, Comedy, Family","oYbVT9e0k2ZSrRhDSCw2Yqshe1n.jpg",7443],["Brothers (2009)",2009,2.5,1,"Robert Eggers","Drama, Thriller, War","skHqceAFYee0JZuYd9MVk2IQggi.jpg",7445],["Tropic Thunder",2008,3.5,1,"Ben Stiller","Action, Comedy, War","zAurB9mNxfYRoVrVjAJJwGV3sPg.jpg",7446],["The Cook, the Thief, His Wife & Her Lover",1989,3.5,1,"Peter Greenaway","Crime, Drama","fNkl7o1VQQqy1nEX9x56CDHULmr.jpg",7452],["The Hitchhiker's Guide to the Galaxy",2005,2,1,"Garth Jennings","Adventure, Comedy, Science Fiction","yr9A3KGQlxBh3yW0cmglsr8aMIz.jpg",7453],["Speed Racer",2008,2,1,"Lilly & Lana Wachowski","Family, Action, Adventure, Comedy","fxRIpx9Op9h71q3tvuabx4GryyP.jpg",7459],["Open Season",2006,2,1,"Roger Allers & Rob Minkoff","Animation, Family, Adventure, Comedy","w5Lctmkc1yah215Luxmci4djaiW.jpg",7484],["Sonatine",1993,3.5,1,"Takeshi Kitano","Action, Crime, Thriller","mX9E4fEuG17L2e7bZmhBc0XdRbw.jpg",7500],["Like Stars on Earth",2007,2,1,"Aamir Khan","Drama","puHRt6Raovm5ujGCdwLWvRv4NHU.jpg",7508],["Idiocracy",2006,2.5,1,"Mike Judge","Comedy, Science Fiction, Adventure, Thriller","6cTHBq49ApwsJaRr3ojlY1cmiXk.jpg",7512],["Over the Hedge",2006,2,1,"Tim Johnson","Adventure, Animation, Comedy, Family","jtZnymorbnHY7mOiBXR14ZDJseM.jpg",7518],["Cocktail",1988,2,1,"Roger Donaldson","Romance, Drama, Comedy","jFRhEPhtsln9tDwzMdZN3OlhUob.jpg",7520],["Déjà Vu",2006,3,1,"Tony Scott","Action, Thriller, Science Fiction","eTX6hklzFOiEVqVukNCEedZKhix.jpg",7551],["Fun with Dick and Jane",2005,2.5,1,"Dean Parisot","Comedy, Crime","xTcIPKpzCqQUQixNPS0Rb7HPEAf.jpg",7552],["The Wave",2008,3.5,1,"Dennis Gansel","Drama, Thriller","vtJ4u0fpTZhibxAJHzXtcdCxhsL.jpg",7735],["Resident Evil: Extinction",2007,2,1,"Russell Mulcahy","Horror, Action, Science Fiction","6yaLr7Ymg5cvbtSVi5hHwBKx35I.jpg",7737],["Amarcord",1973,3.5,1,"Federico Fellini","Comedy, Drama","6PcyPeenUgVb0S7htBKnW5xcVHy.jpg",7857],["Half Nelson",2006,4,1,"Ryan Fleck & Anna Boden","Drama","fdUCisMpTwy0oJOGwM7NrFFs400.jpg",7859],["Shine",1996,3,1,"Scott Hicks","Drama","cbmThowj2XAW7lKlMAXmnhZvjGI.jpg",7863],["Before the Devil Knows You're Dead",2007,3,1,"Sidney Lumet","Crime, Drama, Thriller","egIP0s1ws6fGHqTsVqVNcaEa5i2.jpg",7972],["The Match Factory Girl",1990,4,1,"Aki Kaurismäki","Drama","zHfabvr3RKEbNfksFBs2Cder91i.jpg",7974],["The Wolfman",2010,2,1,"Joe Johnston","Horror","fQqPoAHvHicie1ttuiV2q0yv9V7.jpg",7978],["The Lovely Bones",2009,2.5,1,"Peter Jackson","Fantasy, Drama","sn0iDphRxQ7I6aLd9igIgACITak.jpg",7980],["In the Name of the Father",1993,4.5,1,"Jim Sheridan","Drama","3NcIkKxaO2SmRVsG1v50XhtmL0f.jpg",7984],["Robin Hood: Men in Tights",1993,2.5,1,"Mel Brooks","Comedy","woexOLEkUlYsPLLuZRK6LjZaF38.jpg",8005],["Behind Enemy Lines",2001,2,1,"John Moore","Action, Drama, Thriller, War","fZReMWU3zszvaktDUqOoWCzHssZ.jpg",8007],["Highlander",1986,2.5,1,"Russell Mulcahy","Adventure, Action, Fantasy","8Z8dptJEypuLoOQro1WugD855YE.jpg",8009],["Germany, Year Zero",1948,3,1,"Roberto Rossellini","Drama","sdxegsjrrvujXvv2GLPENyDlWDI.jpg",8016],["Matador",1986,3,1,"Pedro Almodóvar","Drama, Thriller","gJJFkADuwOzDesxuP2jH1WbvFzA.jpg",8047],["Punch-Drunk Love",2002,4,1,"Paul Thomas Anderson","Romance, Drama, Comedy","htYp4yqFu4rzBEIa6j9jP8miDm3.jpg",8051],["Hard Eight",1996,3.5,1,"Paul Thomas Anderson","Drama, Crime","1l5UaoP25Ak8PWCKIULQz70yF03.jpg",8052],["The Imaginarium of Doctor Parnassus",2009,3,1,"Terry Gilliam","Adventure, Fantasy, Mystery","DtrqQHa0wT9AWrk2WA9beROJJx.jpg",8054],["The Reader",2008,2.5,1,"Stephen Daldry","Drama, Romance","r0WURbmnhgKeBpHcpDULBgRedQM.jpg",8055],["Desperado",1995,3.5,1,"Robert Rodriguez","Thriller, Action, Crime","e3gwpBeXpvGZsxUya9zNym5QXrw.jpg",8068],["Barbarella",1968,2.5,1,"Roger Vadim","Science Fiction, Adventure, Comedy","facTz5BZz4AkJal1FWgjYciekih.jpg",8069],["The Room",2003,0.5,1,"François Truffaut","Drama","8D2Oty3FpihcNoNowuYbzOaXKsv.jpg",8070],["Alphaville",1965,3,1,"Jean-Luc Godard","Drama, Science Fiction, Mystery","fFJP3D5fJDFxN7ChqSye1DZ0fTL.jpg",8072],["Band of Outsiders",1964,4,1,"Jean-Luc Godard","Crime, Drama, Comedy","9oqyj79xmcypxLajJdefOtrYx64.jpg",8073],["Alien³",1992,2.5,1,"David Fincher","Science Fiction, Action, Horror","xh5wI0UoW7DfS1IyLy3d2CgrCEP.jpg",8077],["Alien Resurrection",1997,2,1,"Jean-Pierre Jeunet","Science Fiction, Horror, Action","9aRDMlU5Zwpysilm0WCWzU2PCFv.jpg",8078],["Broken Embraces",2009,4,1,"Pedro Almodóvar","Drama, Romance, Thriller","uPTOKnc9bzPp1emH3TyuKOGIylQ.jpg",8088],["This Boy's Life",1993,3,1,"Michael Caton-Jones","Drama","pRMSZfen1Cv1eqwDbtxCBpBqxnU.jpg",8092],["Desperately Seeking Susan",1985,2,1,"Susan Seidelman","Comedy, Crime","ighImRgzYzZ88skBHaT4B7ntJG8.jpg",8130],["Napoleon Dynamite",2004,4,1,"Jared Hess","Comedy","6Iv6Uwa2SBLN0dSGM00rdrwN4MJ.jpg",8193],["Ronin",1998,3,1,"John Frankenheimer","Action, Thriller, Crime","AirrhRJjHwytOV0pdLu7YZ4DEyr.jpg",8195],["The Man Who Knew Too Much",1934,2.5,1,"Alfred Hitchcock","Thriller, Mystery","qghwbSfQblFYRFq675uK5qDGr3w.jpg",8208],["Meet the Feebles",1989,2,1,"Peter Jackson","Comedy, Music, Fantasy","31DqGazwdE9N4Y9FHC6Q4NvstuW.jpg",8216],["Labyrinth of Passion",1982,2.5,1,"Pedro Almodóvar","Comedy, Drama, Romance","jkyRAC2RVfm65LPA6KdqdiobDe2.jpg",8219],["Dark Habits",1983,2.5,1,"Pedro Almodóvar","Comedy, Drama","AB9cm20W0lGebbI39swUmdYZAV.jpg",8220],["What Have I Done to Deserve This?",1984,3.5,1,"Pedro Almodóvar","Comedy, Drama","fcvNzyRQnzgUm31mpRhrq5L7nkY.jpg",8221],["High Heels",1991,4.5,1,"Pedro Almodóvar","Drama, Comedy, Crime","xUpMr3ma8XMpdDhM27s4EuFxdyC.jpg",8222],["Kika",1993,3.5,1,"Pedro Almodóvar","Comedy, Drama","jUEBKaMqcvrz0HHF8Cei8asjRWr.jpg",8223],["Jumper",2008,1.5,1,"Doug Liman","Action, Adventure, Science Fiction","3pPZ9JhNz3VMmASVir5SMHvTDUU.jpg",8247],["The Pope's Toilet",2007,3.5,1,"César Charlone","Drama, Comedy","kn2GWfyqYzlSLZYQpocO4LT01yE.jpg",8267],["Disturbia",2007,2,1,"D.J. Caruso","Thriller, Drama, Mystery","3f9KwSrieczuH9nRrwfOsoMoMNd.jpg",8271],["The Savages",2007,4,1,"Tamara Jenkins","Drama, Comedy","nY54gSmTOmSXlQpWDB7DWp4u8a7.jpg",8272],["In Bruges",2008,4.5,1,"Martin McDonagh","Comedy, Drama, Crime","vz3Vd6nfq9YZrVvyYx5RHFaYKV3.jpg",8321],["Holes",2003,2.5,1,"Andrew Davis","Adventure, Family, Drama, Comedy","o2Dm2mcE1qW8vT0bpsJO5OMBbqa.jpg",8326],["The Holy Mountain",1973,4.5,1,"Alejandro Jodorowsky","Drama","mP5FGQbNjFkrjcZ6AVHrvokPRe5.jpg",8327],["[REC]",2007,4,1,"Jaume Balagueró","Horror, Mystery","hgyJR4sgMsee6xMFM3xYiG6cDCh.jpg",8329],["They Live",1988,3.5,1,"John Carpenter","Science Fiction, Action, Thriller","ngnybFTuopfbfmmEeX9jjBQQmF6.jpg",8337],["Turtles Can Fly",2004,4,1,"Bahman Ghobadi","Drama","iNJxHYyFpmqRjgZ4oa5qQna904i.jpg",8340],["Ice Age: Dawn of the Dinosaurs",2009,2,1,"Carlos Saldanha","Animation, Comedy, Family, Adventure","cXOLaxcNjNAYmEx1trZxOTKhK3Q.jpg",8355],["Cast Away",2000,4,1,"Robert Zemeckis","Adventure, Drama","7lLJgKnAicAcR5UEuo8xhSMj18w.jpg",8358],["Superbad",2007,3.5,1,"Greg Mottola","Comedy","ek8e8txUyUwd2BNqj6lFEerJfbq.jpg",8363],["Transformers: Revenge of the Fallen",2009,1.5,1,"Michael Bay","Science Fiction, Action, Adventure","pLBb0whOzVDtJvyD4DPeQyQNOqp.jpg",8373],["¡Three Amigos!",1986,2.5,1,"John Landis","Comedy, Western, Action","dUNRnhl2cwjFJ6TOsaPJmZeMZ0S.jpg",8388],["My Neighbor Totoro",1988,4,1,"Hayao Miyazaki","Fantasy, Animation, Family","rtGDOeG9LzoerkDGZF9dnVeLppL.jpg",8392],["The Gods Must Be Crazy",1980,3,1,"Jamie Uys","Action, Comedy","IgBfj5LfT7nwpodCZ34QCHp17x.jpg",8393],["Day of the Dead",1985,4,1,"George A. Romero","Horror, Drama, Mystery","bi7SO5F4VyyGQTlxQirbH1dwKzW.jpg",8408],["The Conformist",1970,3.5,1,"Bernardo Bertolucci","Drama","nLJjFRqIJAK8qz0OKYnpKCblZNK.jpg",8416],["Zidane: A 21st Century Portrait",2006,2.5,1,"Douglas Gordon","Documentary","6zvoqWwSEYz3L7gnp9RHqbIoSJg.jpg",8421],["Rocco and His Brothers",1960,4,1,"Luchino Visconti","Drama, Romance, Crime","pngL8AraChIDOiWnKF2o3S9kJzJ.jpg",8422],["Bugsy Malone",1976,2,1,"Alan Parker","Drama, Action, Comedy, Music, Family","j9BPl3jkNCFgsYe5poKrirUqrf8.jpg",8446],["The 6th Day",2000,2,1,"Roger Spottiswoode","Action, Science Fiction, Thriller","rODFJOFiPk1UVCe4pmBza8T6feO.jpg",8452],["Funny Games (2007)",2007,3.5,1,"Michael Haneke","Thriller, Horror","zs92sAOh3Q0kDIJkgaJFTBzSFka.jpg",8461],["Dumb and Dumber",1994,3,1,"Peter Farrelly & Bobby Farrelly","Comedy","4LdpBXiCyGKkR8FGHgjKlphrfUc.jpg",8467],["Animal House",1978,2,1,"John Landis","Comedy","fWooBbipMRIKeSRhEzmeaDV0T8H.jpg",8469],["Wild Wild West",1999,2.5,1,"Barry Sonnenfeld","Action, Adventure, Comedy, Science Fiction, Western","mCdo7nykEVCa25bjnkwgyX35fjm.jpg",8487],["Superman II",1980,3,1,"Richard Lester","Science Fiction, Action, Adventure","3xk5cno9BHcnwc97XO9k21aI1Zi.jpg",8536],["Shanghai Noon",2000,3,1,"Tom Dey","Adventure, Comedy, Western","b0WwWRcDiDahkah5vZ0KjB4N9ZZ.jpg",8584],["The Lion King",1994,4.5,2,"Roger Allers & Rob Minkoff","Animation, Family, Drama","sKCr78MXSLixwmZ8DyJLrpMsd15.jpg",8587],["The Lion King (2019)",2019,1.5,1,"Jon Favreau","Animation, Family, Drama","sKCr78MXSLixwmZ8DyJLrpMsd15.jpg",8587],["Lion",2016,3,1,"Garth Davis","Animation, Family, Drama","sKCr78MXSLixwmZ8DyJLrpMsd15.jpg",8587],["Dick Tracy",1990,2.5,1,"Warren Beatty","Adventure, Comedy, Crime","sjeP4bpgsUvAGE8oFcICy2GaHxw.jpg",8592],["Master and Commander: The Far Side of the World",2003,4,1,"Peter Weir","Adventure, Drama, War","s1cVTQEZYn4nSjZLnFbzLP0j8y2.jpg",8619],["The Happening",2008,1.5,1,"M. Night Shyamalan","Thriller, Science Fiction","fP4nBrtmc0teSDDHzYmDE7TLQBT.jpg",8645],["Bringing Out the Dead",1999,3.5,1,"Martin Scorsese","Drama","gE2Q8mL0m0EA6HakRyc92uzSPJn.jpg",8649],["The Isle",2000,4,1,"Kim Ki-duk","Drama, Thriller","zl8QGUiyjkdS7JNoPeXB7HLzYJR.jpg",8653],["Deep Impact",1998,2.5,1,"Mimi Leder","Action, Drama, Science Fiction","a3vQS7JKqlOb3MdVJHuTCP9s7Mg.jpg",8656],["Fool's Gold",2008,1,1,"Andy Tennant","Adventure, Romance, Comedy","f4djEBW3nyGRPLTcDlWYyaO43mx.jpg",8676],["Taken",2008,2.5,1,"Pierre Morel","Action, Thriller","ognkaUSNgJe1a2pjB4UNdzEo5jT.jpg",8681],["Who Am I?",1998,2.5,1,"Jackie Chan","Adventure, Action, Comedy, Thriller","9YDKLbBmWGpxG5bO3TBawtNNOAr.jpg",8697],["The League of Extraordinary Gentlemen",2003,1.5,1,"Stephen Norrington","Fantasy, Action, Thriller, Science Fiction","kdAuVFP63XXxnb983ry2pLCKd9S.jpg",8698],["Anchorman: The Legend of Ron Burgundy",2004,3,1,"Adam McKay","Comedy","mhZIcRePT7U8viFQVjt1ZjYIsR4.jpg",8699],["The Thin Red Line",1998,4,1,"Terrence Malick","Drama, History, War","seMydAaoxQP6F0xbE1jOcTmn5Jr.jpg",8741],["Eagle vs Shark",2007,2.5,1,"Taika Waititi","Comedy, Romance","bHGHxXX8jOLV33r8rf1wjBkIdgr.jpg",8748],["Top Secret!",1984,4,2,"Jerry Zucker & David Zucker & Jim Abrahams","Comedy","hRTbfR27xghnVMs3ZJ3EhK3zzud.jpg",8764],["Christine",1983,3,1,"John Carpenter","Horror","mMtUJke2TtIoT6JB9hkvERmsSu8.jpg",8769],["Mad Max 2",1981,3.5,1,"George Miller","Action, Thriller, Science Fiction","l1KVEhkGDpWRzQ0VqIhZqDDuOim.jpg",8810],["Il Divo",2008,3,1,"Paolo Sorrentino","Drama","ytmCT1nnPMhuIxXO7z2ruD4gHUF.jpg",8832],["Legally Blonde",2001,2.5,1,"Robert Luketic","Comedy","9ohlMrJHQqKhfUKh7Zr3JQqHNLZ.jpg",8835],["Mercury Rising",1998,2,1,"Harold Becker","Action, Crime, Drama, Thriller","60AAso6I2TzQCy2SjqtzPni8csA.jpg",8838],["Casper",1995,2,1,"Brad Silberling","Fantasy, Comedy, Family","2ah8fNJFZVU3vcXhU5xfAYi2eym.jpg",8839],["DragonHeart",1996,2.5,1,"Rob Cohen","Fantasy, Action, Adventure, Drama","1J2FvxEoEKMFT9TjUdfhm0MJhZD.jpg",8840],["Jumanji",1995,3.5,1,"Joe Johnston","Adventure, Fantasy, Family","vgpXmVaVyUL7GGiDeiK1mKEKzcX.jpg",8844],["The Blob",1958,1.5,1,"Irvin S. Yeaworth Jr.","Horror, Science Fiction","ctOwn1Ibg3SjDG4WulvFvSH0PRT.jpg",8851],["Prince of Darkness",1987,3,1,"John Carpenter","Horror","jjcAOhtGuX4p8XvlVn1WXUT1jWi.jpg",8852],["How the Grinch Stole Christmas",2000,3,1,"Ron Howard","Family, Comedy, Fantasy","1WZbbPApEivA421gCOluuzMMKCk.jpg",8871],["Wayne's World",1992,3,1,"Penelope Spheeris","Comedy, Music","fHwZnFNWR7PaS9t5EBwTvGPeoYQ.jpg",8872],["Che: Part One",2008,3,1,"Steven Soderbergh","Drama, History, War","ndxoK8RZF1nfHvZzQ3f2sNlkkzg.jpg",8881],["Waltz with Bashir",2008,4.5,1,"Ari Folman","Animation, Documentary, Drama, War","zQaCv7lKwHsh0YSHkt1QNjIOZ1c.jpg",8885],["Wanted",2008,1.5,1,"Timur Bekmambetov","Action, Thriller, Crime","njy7Pz7ZHZceO7lNfGIHKphY8Hd.jpg",8909],["Pet Sematary",1989,2.5,1,"Mary Lambert","Horror","a1gIACZb04bL8EvLqMpofW2Eqeo.jpg",8913],["Deep Blue Sea",1999,1.5,1,"Renny Harlin","Action, Horror, Science Fiction","fyn0zyCI4kIlbDoHH0Hzv09hDC5.jpg",8914],["Antz",1998,3,1,"Eric Darnell & Tom McGrath","Animation, Comedy, Family","lWPjxbUMpAHFkJpZHHNWhQaRsax.jpg",8916],["Garfield",2004,1,1,"Peter Hewitt","Comedy, Family","vqwTSWNLyH55g8kBT61s2DgNYEp.jpg",8920],["Tokyo!",2008,2.5,1,"Michel Gondry","Comedy, Drama, Fantasy, Romance","6xbq2EBAOwy0V7bzd1um3sJX1jd.jpg",8938],["Wendy and Lucy",2008,4,1,"Kelly Reichardt","Drama","cVtF8SW4zMbculTXD52RDvmQAAR.jpg",8942],["I Love You Phillip Morris",2009,2.5,1,"Glenn Ficarra","Comedy, Crime, Drama, Romance","qtAuWLGQ7N4PNQ6boZeqqoUY2l9.jpg",8952],["Hancock",2008,2,1,"Peter Berg","Fantasy, Action","7DyuV2G0hLEqHeueDfOqhZ2DVut.jpg",8960],["Bad Boys II",2003,2.5,1,"Michael Bay","Action, Crime, Comedy","yCvB5fG5aEPqa1St7ihY6KEAsHD.jpg",8961],["Atlantis: Milo's Return",2003,1.5,1,"Tad Stones","Fantasy, Animation, Science Fiction, Family, Action","hyAbWGld5WLdrmUB9OHyewcJQGL.jpg",8965],["Twilight",2008,1,1,"Catherine Hardwicke","Fantasy, Drama, Romance","3Gkb6jm6962ADUPaCBqzz9CTbn9.jpg",8966],["The Tree of Life",2011,4.5,1,"Terrence Malick","Drama, Fantasy","l8cwuB5WJSoj4uMAsnzuHBOMaSJ.jpg",8967],["The War of the Worlds",1953,3,1,"Byron Haskin","Science Fiction, Action","gzc75Za4ArqfXIIr7STNnIE5rnA.jpg",8974],["Hellraiser",1987,2.5,1,"Clive Barker","Horror, Thriller","3Z0oPHyLnk3Vx6ZMC1MiVwIrKhO.jpg",9003],["Just Like Heaven",2005,2.5,1,"Mark Waters","Comedy, Romance, Fantasy","2cLbyVNhEEaUJGg7rfbLtX6454I.jpg",9007],["The Insider",1999,4,1,"Michael Mann","Drama, Thriller","jJCyIBPfvk41uETq6K6u4upyGO8.jpg",9008],["Jackass: The Movie",2002,3.5,1,"Jeff Tremaine","Action, Comedy, Documentary","9Rb659hvGfmef1xm0mMvDHEBqmf.jpg",9012],["Midnight Run",1988,3.5,1,"Martin Brest","Comedy, Crime, Thriller","yx0touyDQ9enWDsFgS4MbBwCSNd.jpg",9013],["Treasure Planet",2002,3.5,1,"John Musker & Ron Clements","Science Fiction, Adventure, Animation, Family, Fantasy","zMKatZ0c0NCoKzfizaCzVUcbKMf.jpg",9016],["The Santa Clause 2",2002,2,1,"Michael Lembeck","Fantasy, Comedy, Family","2EAMkz0z1pbr9weOY1Y7buy2AxV.jpg",9021],["Spirit: Stallion of the Cimarron",2002,3,1,"Kelly Asbury","Animation, Adventure, Family, Drama, Western","cUgYrz4twiJ3QgVGpRfey984NIB.jpg",9023],["The Great Silence",1968,3.5,1,"Sergio Corbucci","Western, Drama","3kpxS7SZMyYSXvhDnmxQXOOxiTM.jpg",9028],["What Happens in Vegas",2008,2,1,"Tom Vaughan","Comedy, Romance","n7bQ7Lj6UhArgnx49wmkaTxM4iU.jpg",9029],["Big Daddy",1999,2.5,1,"Dennis Dugan","Comedy, Drama","cqFnFg6YS8urJT6YC95IDkn0VHz.jpg",9032],["Slither",2006,3.5,1,"James Gunn","Horror, Science Fiction, Comedy","zNlJvCY3Pz7SE09Lf4G7uPs5XFZ.jpg",9035],["Serpico",1973,4,1,"Sidney Lumet","Crime, Drama, History","pRagfd10PPWryFRSzLPIivfAXHJ.jpg",9040],["Police Story",1985,4.5,2,"Jackie Chan","Action, Crime, Comedy","1eFB0Iy1TMU4VO5hMcoCE064JAT.jpg",9056],["Little Man",2006,0.5,1,"Keenen Ivory Wayans","Comedy, Crime","9KzPw1VN0pMBnq1KIqBaLI8LAB7.jpg",9072],["The Sword in the Stone",1963,3.5,1,"Wolfgang Reitherman","Animation, Family, Fantasy","7lyeeuhGAJSNXYEW34S8mJ1bwI8.jpg",9078],["Waking Life",2001,3.5,1,"Richard Linklater","Animation, Drama, Fantasy","2MRM4PL6H7yraAkwyUEe2EqoQH3.jpg",9081],["To Wong Foo, Thanks for Everything! Julie Newmar",1995,3.5,1,"Beeban Kidron","Comedy, Drama","8bkJiI6N8wDxAtQ49bLUt0qCBII.jpg",9090],["The Craft",1996,2.5,1,"Andrew Fleming","Horror, Drama, Fantasy","8bW2RdRkloYtEPhbQZN4wcdmJP4.jpg",9100],["Hot Shots! Part Deux",1993,2.5,1,"Jerry Zucker & David Zucker & Jim Abrahams","Action, Comedy, War","zh9EGK970GHo10ETclWBOjZVUOK.jpg",9255],["And Now for Something Completely Different",1971,3,1,"Ian MacNaughton","Comedy","ajbdFQLvJTlNu4LnVWGnNMb4mZ8.jpg",9267],["Brick",2005,3.5,1,"Rian Johnson","Drama, Mystery, Crime","5WVk8JpNIxepn4fpZzQeCumkOL5.jpg",9270],["Ace Ventura: When Nature Calls",1995,2.5,1,"Steve Oedekerk","Crime, Comedy, Adventure","wcinCf1ov2D6M3P7BBZkzQFOiIb.jpg",9273],["The Faculty",1998,3,1,"Robert Rodriguez","Horror, Science Fiction","5XetJwmAiDC0EtH23NIXaqFn3Wl.jpg",9276],["The Sting",1973,4,1,"George Roy Hill","Comedy, Crime, Drama","4VdQopZb0lx13Me3yxE5rUXMGCI.jpg",9277],["Jingle All the Way",1996,3,1,"Brian Levant","Family, Adventure, Comedy","6QLkeLXPIxiihuX5enHHNEuCCzy.jpg",9279],["Femme Fatale",2002,2.5,1,"Brian De Palma","Mystery, Crime, Thriller","i2OgxmZVbIsJxaLiYMjCSewsLty.jpg",9280],["Witness",1985,3.5,1,"Peter Weir","Crime, Drama, Thriller","kOymD1rChAMykmDVEzJpIh4OYS7.jpg",9281],["Final Destination 3",2006,2.5,1,"James Wong","Horror, Mystery","p7ARuNKUGPGvkBiDtIDvAzYzonX.jpg",9286],["The Longest Yard",2005,2,1,"Peter Segal","Drama, Comedy, Crime","nbKcVBcxF96ARW2oKHqDYAcLdu.jpg",9291],["Monster House",2006,3,2,"Gil Kenan","Animation, Comedy, Family, Fantasy","zCRPr4bkO3ae0U1134vJ39xZnAG.jpg",9297],["Thesis",1996,4.5,1,"Alejandro Amenábar","Horror, Thriller","w1ynKTlqOfbIMwcDsTSvCku9bQg.jpg",9299],["Orlando",1992,3.5,1,"Sally Potter","Drama, Fantasy","otSCGdKzEeVgbfNl0YslOpRZHgk.jpg",9300],["Bound",1996,3.5,1,"Lilly & Lana Wachowski","Drama, Thriller, Crime","9qAy6UWVw44dGrsyKrdEMt5qIUM.jpg",9303],["The Man in the Iron Mask",1998,2.5,1,"Randall Wallace","Adventure, Action, Drama","zHE9yRURvA7DyhYtQxkGTfE1Ywi.jpg",9313],["Nineteen Eighty-Four",1984,3.5,1,"Michael Radford","Drama, Science Fiction, Thriller","hrdQlicxuyTg3zyVqq78EsA4Z6J.jpg",9314],["Ghost in the Shell",1995,3,1,"Mamoru Oshii","Action, Animation, Science Fiction","9gC88zYUBARRSThcG93MvW14sqx.jpg",9323],["The Jungle Book",1967,3.5,1,"Wolfgang Reitherman","Family, Animation, Adventure","9BgcTVV43dZ8A1TpuXWkuNTXtfI.jpg",9325],["The Nutty Professor (1996)",1996,2,1,"Tom Shadyac","Comedy, Science Fiction, Romance","fMtb5aZoLRNbMnCkatFsTmPRfl5.jpg",9327],["The Scorpion King",2002,1.5,1,"Chuck Russell","Action, Adventure, Fantasy","aITIsX20tACn6jgtyDcCYpRT216.jpg",9334],["Transporter 2",2005,2.5,1,"Louis Leterrier","Action, Thriller, Crime","cdm17vK8PxHfTi7ayZf6WKbOgUO.jpg",9335],["Police Academy",1984,2,1,"Hugh Wilson","Comedy, Crime","qxUkWoFI7rF1KUgTgbE3UJEQuvG.jpg",9336],["Click",2006,2.5,1,"Frank Coraci","Comedy, Drama, Fantasy","oL0k5JA53PyoHSZqKb3cNkhwBCE.jpg",9339],["The Goonies",1985,2.5,1,"Richard Donner","Adventure, Comedy, Family","eBU7gCjTCj9n2LTxvCSIXXOvHkD.jpg",9340],["The Core",2003,1.5,1,"Jon Amiel","Science Fiction, Adventure, Thriller","iMPR3OFhKNVvJw4eZoRhf9RzfHJ.jpg",9341],["The Mask of Zorro",1998,3.5,1,"Martin Campbell","Action, Adventure","bdMufwGDDzqu4kTSQwrKc5WR4bu.jpg",9342],["Fitzcarraldo",1982,4,1,"Werner Herzog","Drama, Adventure","oBCnYEKcg1rMhr5JjDnrRpilvDd.jpg",9343],["EuroTrip",2004,3,1,"Jeff Schaffer","Comedy","iLdO4PwbZCCQSa9rchZMwuJm9xe.jpg",9352],["Nacho Libre",2006,2.5,1,"Jared Hess","Comedy, Action, Family","kh7B91bMl2lZ0mH9WhPfaNUIEQH.jpg",9353],["Honey, I Shrunk the Kids",1989,3,1,"Joe Johnston","Adventure, Comedy, Family, Science Fiction","omQOzahi2NIeiYznNxHFDvNbvo6.jpg",9354],["Mad Max Beyond Thunderdome",1985,2.5,1,"George Miller","Action, Adventure, Science Fiction","jJlxcEVVUHnrUeEkQ0077VeHQpb.jpg",9355],["Look Who's Talking Too",1990,2,1,"Amy Heckerling","Romance, Comedy","m409mVHmvDOZJltNzHJYigUthsW.jpg",9356],["One Hour Photo",2002,3.5,1,"Mark Romanek","Drama, Thriller","tT94IR3zxp09PwPWHIw7FP7Y8Bd.jpg",9357],["Final Destination 2",2003,2,1,"David R. Ellis","Horror, Mystery","vnFgxRlLTA9fDNcGXLiHmgwmIEo.jpg",9358],["Anaconda",1997,1,1,"Luis Llosa","Adventure, Horror, Thriller","33NysOnLpLZY0ewHTcfpalzAsRG.jpg",9360],["The Last of the Mohicans",1992,4,1,"Michael Mann","History, War, Drama","qzJMPWRtZveBkxXOv3ucWhoJuyj.jpg",9361],["Tremors",1990,3.5,1,"Ron Underwood","Comedy, Horror, Science Fiction","cA4ggkZ3r1d5r9hOAUWC8x5ul2i.jpg",9362],["Wuthering Heights (2011)",2011,3.5,1,"Andrea Arnold","Drama, Romance","7gEcoCve3lmPOIPRp54K73b6rDv.jpg",9364],["Donnie Brasco",1997,3.5,1,"Mike Newell","Crime, Drama, Thriller","xtKLvpOfARi1XVm8u2FTdhY5Piq.jpg",9366],["El Mariachi",1992,3,1,"Robert Rodriguez","Action, Crime, Thriller, Western","zRh7K4SV1xQ419m8gzGITak51vc.jpg",9367],["Death Becomes Her",1992,3.5,1,"Robert Zemeckis","Comedy, Fantasy, Horror","kkWxyyyWFK5KNk9WVwQuGEC9H9H.jpg",9374],["Ferris Bueller's Day Off",1986,3,1,"John Hughes","Comedy","9LTQNCvoLsKXP0LtaKAaYVtRaQL.jpg",9377],["Hollow Man",2000,2,1,"Paul Verhoeven","Action, Science Fiction, Thriller","sd3qUIv5uoP2oTbqv66CzXSPjKG.jpg",9383],["Starsky & Hutch",2004,2,1,"Todd Phillips","Comedy, Crime","fmBYVkBjhVspPv3GGus84qhBo1a.jpg",9384],["Thank You for Smoking",2005,3.5,1,"Jason Reitman","Comedy, Drama","cJpeM7U36diFinieBWNLVi0FlQz.jpg",9388],["Jerry Maguire",1996,3,1,"Cameron Crowe","Comedy, Drama, Romance","lABvGN7fDk5ifnwZoxij6G96t2w.jpg",9390],["The Descent",2005,3.5,1,"Neil Marshall","Adventure, Horror","mxFPI4KYBk5ri9cPteIS8jiDFgj.jpg",9392],["Evolution",2001,2.5,1,"Ivan Reitman","Comedy, Science Fiction, Action","dwIrP544LxJtXToLpzkEa08pIMm.jpg",9397],["Zoolander",2001,3,1,"Ben Stiller","Comedy","qdrbSneHZjJG2Dj0hhBxzzAo4HB.jpg",9398],["Surf's Up",2007,3,1,"Chris Buck","Animation, Comedy, Family","kAeZfUDmuhnL8pLnxxFxBhYVdm6.jpg",9408],["Great Expectations (1998)",1998,2.5,1,"Alfonso Cuarón","Comedy, Drama, Romance","djLsfl3lm7BZKWsKfVZ2wM1ZMrP.jpg",9410],["The Man Who Knew Too Little",1997,3,1,"Jon Amiel","Comedy, Crime, Action","yVlIZa0u6CTN5LudxGX77Fk46iz.jpg",9414],["The Fly",1986,4.5,1,"David Cronenberg","Horror, Science Fiction","8gZWMhJHRvaXdXsNhERtqNHYpH3.jpg",9426],["The Full Monty",1997,3,1,"Peter Cattaneo","Comedy","crtSEBd4ya9r5oEFHRatAud6Id8.jpg",9427],["The Royal Tenenbaums",2001,4,1,"Wes Anderson","Comedy, Drama","nG7hZJn7wQTSDCQT39Gy3s3tbrp.jpg",9428],["Dead Men Don't Wear Plaid",1982,2.5,1,"Carl Reiner","Comedy, Mystery, Crime","cwYwZBEE73PakUWzbICzxYKlXAz.jpg",9442],["Chariots of Fire",1981,2,1,"Hugh Hudson","Drama, History","qnRaum8k0HqGRml2i7OawFqUtEb.jpg",9443],["Anastasia",1997,3.5,1,"Don Bluth","Animation, Family, Fantasy, Adventure","bppGWGA8zq1sRvTdDJnUzVW9GcH.jpg",9444],["Babe: Pig in the City",1998,3.5,1,"George Miller","Family, Adventure, Comedy, Drama","glO6LcTWUZcbxWT2SB4eRDnFSsP.jpg",9447],["Election",1999,4,1,"Alexander Payne","Comedy, Drama","5gPOFU6IPvDrx50XaPCK4twNw79.jpg",9451],["Buffalo '66",1998,4.5,1,"Vincent Gallo","Drama, Romance, Comedy","fxzXFzbSGNA52NHQCMqQiwzMIQw.jpg",9464],["Kung Fu Hustle",2004,3.5,1,"Stephen Chow","Action, Comedy, Crime, Fantasy","exbyTbrvRUDKN2mcNEuVor4VFQW.jpg",9470],["Charlie's Angels: Full Throttle",2003,2,1,"McG","Action, Adventure, Comedy","n4cdJ0Wqxb7C0HmZbcaC4eYnkIf.jpg",9471],["DodgeBall: A True Underdog Story",2004,2,1,"Rawson Marshall Thurber","Comedy","r8KbNHkkwFXLjV1suGwm0Qjure5.jpg",9472],["True",2004,4,1,"Tom Tykwer","Comedy","r8KbNHkkwFXLjV1suGwm0Qjure5.jpg",9472],["South Park: Bigger, Longer & Uncut",1999,3.5,1,"Trey Parker","Animation, Comedy","tS0PedvA2mFO9VCHYwQpaU1K36U.jpg",9473],["My Name Is Nobody",1973,3.5,1,"Tonino Valerii","Comedy, Western","tJQEVI1p00Jh9TUgNEI623iu7ST.jpg",9474],["Scent of a Woman",1992,3.5,1,"Martin Brest","Drama","4adI7IaveWb7EidYXfLb3MK3CgO.jpg",9475],["A Knight's Tale",2001,3.5,1,"Brian Helgeland","Adventure, Drama, Romance, Action","srb1XnrlDZHcdpjBKqUu4qAzxKU.jpg",9476],["King Arthur",2004,2,1,"Antoine Fuqua","Adventure, War, History, Action, Drama","iKLZEAnjzr51Ij7TJtNejc5CN3i.jpg",9477],["The Nightmare Before Christmas",1993,4.5,3,"Henry Selick","Animation, Family, Fantasy","oQffRNjK8e19rF7xVYEN8ew0j7b.jpg",9479],["Daredevil",2003,1.5,1,"Mark Steven Johnson","Fantasy, Action","oCDBwSkntYamuw8VJIxMRCtDBmi.jpg",9480],["A Bug's Life",1998,4,3,"John Lasseter","Adventure, Animation, Comedy, Family","Ah3J9OJVc2CNCuH2zMydXy9fmIC.jpg",9487],["Spy Kids 2: The Island of Lost Dreams",2002,2.5,1,"Robert Rodriguez","Family, Action, Adventure, Comedy, Science Fiction","z8pfWCk6SlxxDLXXQdUHdxF5dwJ.jpg",9488],["You've Got Mail",1998,3,1,"Nora Ephron","Comedy, Romance","e2uVtH6TpMfUl7WeOM70ezkcjsU.jpg",9489],["Look Who's Talking",1989,2.5,1,"Amy Heckerling","Comedy, Romance","uVM0D7Q6U9H6xMSZmMdfwECih5h.jpg",9494],["Kung Fu Panda",2008,3.5,1,"Mark Osborne","Family, Comedy, Animation, Action","wWt4JYXTg5Wr3xBW2phBrMKgp3x.jpg",9502],["Glengarry Glen Ross",1992,4,1,"James Foley","Crime, Drama, Mystery","nGZCeCfNseq1ee3cJLBp0rH0djT.jpg",9504],["Anger Management",2003,2,1,"Peter Segal","Comedy","8wX3S5HjL3bgb2yi4CfR2qIqbdH.jpg",9506],["Man on Fire",2004,3.5,1,"Tony Scott","Action, Drama, Thriller","grCGLCcTHv9TChibzOwzUpykcjB.jpg",9509],["Garfield: A Tail of Two Kitties",2006,0.5,1,"Tim Hill","Comedy, Family, Adventure","O2j1bwErQ6bbBVZM5Vxg3Tsoir.jpg",9513],["Candyman",1992,3,1,"Bernard Rose","Drama, Horror, Thriller","jQtgkgDZE7egMq532sOt83DnT83.jpg",9529],["RV",2006,1.5,1,"Barry Sonnenfeld","Family, Comedy, Adventure","eqV0JjfwcEJuK3JPZ2rsNvS1p30.jpg",9530],["Superman III",1983,2,1,"Richard Lester","Comedy, Science Fiction, Action, Adventure","c4oR6qgZW2s5foGkQi2Dd86KuAS.jpg",9531],["Final Destination",2000,3.5,1,"James Wong","Horror","1mXhlQMnlfvJ2frxTjZSQNnA9Vp.jpg",9532],["Red Dragon",2002,2.5,1,"Brett Ratner","Crime, Thriller, Horror","ou9ZKA2cms02b7CdCdVqGkKu0O0.jpg",9533],["Analyze This",1999,3,1,"Harold Ramis","Comedy, Crime","eqa4TEgkx63WRhqyD8eTwmL7bUi.jpg",9535],["Scanners",1981,3,1,"David Cronenberg","Science Fiction, Horror","VTqLdveNXxGsIAZL5I4RliTTt7.jpg",9538],["Martyrs",2008,3,1,"Pascal Laugier","Horror, Drama, Thriller","eaaoQLCT38CrKxX53WRpjw1ZPVz.jpg",9539],["Dead Ringers",1988,4,1,"David Cronenberg","Thriller, Horror","ofXwDfM8uYAaftD7cBPcIWdCpMn.jpg",9540],["House of Flying Daggers",2004,3.5,1,"Zhang Yimou","Adventure, Drama, Action","93feGsGiCtG5ymrRcErUgBsdo6v.jpg",9550],["The Exorcist",1973,4.5,1,"William Friedkin","Horror","5x0CeVHJI8tcDx8tUUwYHQSNILq.jpg",9552],["Darkman",1990,2.5,1,"Sam Raimi","Action, Science Fiction, Thriller","9fxGRzlINIvfPFhizMgbQaDDrK.jpg",9556],["Dazed and Confused",1993,3,1,"Richard Linklater","Comedy, Drama","msG9awbLhVZwv1Eh9Ge7SofMexW.jpg",9571],["Tootsie",1982,2.5,1,"Sydney Pollack","Comedy, Romance","ngyCzZwb9y5sMUCig5JQT4Y33Q.jpg",9576],["That Thing You Do!",1996,3,1,"Tom Hanks","Comedy, Drama, Music","9RmZu33qHdyZFGLfhEOmkTjdNEu.jpg",9591],["Last Action Hero",1993,2.5,1,"John McTiernan","Fantasy, Action, Comedy","vkhEaWAv5j3qgrOGp3BgMeiYPKj.jpg",9593],["Hot Shots!",1991,2.5,1,"Jerry Zucker & David Zucker & Jim Abrahams","Action, Comedy, War","koLIB5263emHxewmwgBBK26vjeS.jpg",9595],["Babe",1995,3.5,1,"Chris Noonan","Fantasy, Drama, Comedy, Family","zKuQMtnbVTz9DsOnOJmlW71v4qH.jpg",9598],["Big Momma's House",2000,2,1,"Raja Gosnell","Crime, Comedy","5YoSFqpTz5qIxsX61CPMGKONQIY.jpg",9600],["Coming to America",1988,3,1,"John Landis","Comedy, Romance","8YZiA1o264dk0cr1USyMdph6SZl.jpg",9602],["Clueless",1995,2.5,1,"Amy Heckerling","Comedy, Romance","8AwVTcgpTnmeOs4TdTWqcFDXEsA.jpg",9603],["Super Mario Bros.",1993,0.5,1,"Annabel Jankel","Adventure, Fantasy, Comedy, Family","yt5bbMfKpg1nRr4k5edxs7tPK2m.jpg",9607],["Happy Gilmore",1996,2.5,1,"Dennis Dugan","Comedy","4RnCeRzvI1xk5tuNWjpDKzSnJDk.jpg",9614],["The Fast and the Furious: Tokyo Drift",2006,2,1,"Justin Lin","Action, Crime, Drama, Thriller","46xqGOwHbh2TH2avWSw3SMXph4E.jpg",9615],["Elizabethtown",2005,2,1,"Cameron Crowe","Comedy, Drama, Romance","mOdlzAQxhMgiaazRzif1YtJzg9s.jpg",9621],["Scooby-Doo",2002,2.5,1,"Raja Gosnell","Mystery, Adventure, Comedy","mTAiBJGg8mqEfnYHHbi37ZoRSZm.jpg",9637],["Cheaper by the Dozen 2",2005,2,1,"Adam Shankman","Comedy, Family, Adventure","wD68dEtcKuboxd8bhbqiTTxn6cX.jpg",9641],["National Lampoon's Loaded Weapon 1",1993,2.5,1,"Gene Quintano","Comedy, Crime, Action","moP0nyVWVisqSeH6nMewWyIPV6z.jpg",9644],["Scrooged",1988,2.5,1,"Richard Donner","Fantasy, Comedy, Drama","uO0znfB2ZzTXA1IS7jkrjNbpkYK.jpg",9647],["Supergirl",1984,1,1,"Jeannot Szwarc","Adventure, Fantasy, Action, Science Fiction","o49a2RDChZkry84LomEORCPDWfk.jpg",9651],["The Italian Job",2003,2.5,1,"F. Gary Gray","Action, Crime","eSkjK4kctyrWpFhxl35GPvSs6tI.jpg",9654],["Mad Max",1979,3,2,"George Miller","Action, Thriller, Science Fiction","5LrI4GiCSrChgkdskVZiwv643Kg.jpg",9659],["The Triplets of Belleville",2003,4.5,2,"Sylvain Chomet","Animation, Comedy, Drama, Adventure","enw6C4fDw88g0nOQgIJXjgH3NHi.jpg",9662],["Crocodile Dundee",1986,3,1,"Peter Faiman","Adventure, Comedy","pduPduL1ub5kok3lPYT15ryC9L6.jpg",9671],["Sideways",2004,4,1,"Alexander Payne","Comedy, Drama, Romance","zOsaxYLgvZVU7cJBpPn8CuE0MrP.jpg",9675],["The Black Dahlia",2006,2,1,"Brian De Palma","Crime, Thriller, Drama","su7yuXqGUHICfoijtcSaxWLE34Y.jpg",9676],["Little Nicky",2000,2,1,"Steven Brill","Comedy, Fantasy","AudA8gnTWSBWXBHSBHnr3HHUXXM.jpg",9678],["New York Stories",1989,3,1,"Martin Scorsese","Comedy, Drama, Romance","mViGEH5dfsAnUgJmce1RJkFycAi.jpg",9686],["Melinda and Melinda",2004,3,1,"Woody Allen","Comedy, Drama, Romance","3cLNqq5dpblYG0QkPgwn763DvJB.jpg",9688],["Children of Men",2006,4.5,1,"Alfonso Cuarón","Science Fiction, Thriller, Action","lQcXgb0fFzffnLV5WY0Q0X2WW7E.jpg",9693],["Ichi the Killer",2001,1.5,1,"Takashi Miike","Action, Crime, Horror","k8j4YLZlda98dqp9ErymKzjYowG.jpg",9696],["Lady in the Water",2006,1.5,1,"M. Night Shyamalan","Drama, Fantasy, Mystery","ddNmoSy1Jd3PBF5XDZvrrBIfrja.jpg",9697],["My Summer of Love",2004,3,1,"Paweł Pawlikowski","Drama, Romance","47eozMel2wZgEASToUzScsPVpDs.jpg",9709],["Home Alone 3",1997,1.5,1,"Raja Gosnell","Comedy, Family","6uOadrCfle0n2LOOxHbgWEdnrm2.jpg",9714],["Talladega Nights: The Ballad of Ricky Bobby",2006,2.5,1,"Adam McKay","Comedy","3iCiTqsmJz1mO85AHzTiHNkRmb6.jpg",9718],["Friday the 13th Part 2",1981,1,1,"Steve Miner","Horror, Thriller","92rGctBMTv4uaSlIBVnhz01kRWL.jpg",9725],["The Lion King II: Simba's Pride",1998,2,1,"Darrell Rooney","Adventure, Animation, Drama, Family, Romance","sWR1x6UCMCGN9xEf8RGhPS934X0.jpg",9732],["Bad Boys",1995,2.5,1,"Michael Bay","Action, Comedy, Crime, Thriller","x1ygBecKHfXX4M2kRhmFKWfWbJc.jpg",9737],["Fantastic Four",2005,2,1,"Tim Story","Action, Fantasy, Science Fiction","4YMcYEFS8sFuW3soP1HVmgR3cSm.jpg",9738],["Demolition Man",1993,2.5,1,"Marco Brambilla","Crime, Action, Science Fiction","dq6AmlVFo92PRuoLCcIyFdoRuxf.jpg",9739],["Hannibal",2001,3,1,"Ridley Scott","Crime, Drama, Thriller","v5wAZwRqpGWmyAaaJ8BBHYuNXnj.jpg",9740],["Unbreakable",2000,3.5,1,"M. Night Shyamalan","Thriller, Drama, Mystery","mLuehrGLiK5zFCyRmDDOH6gbfPf.jpg",9741],["Kundun",1997,3,1,"Martin Scorsese","Drama, History","yvdFRDoQIQ5PBk4u8x8gJT8NJAw.jpg",9746],["Epic Movie",2007,0.5,1,"Jason Friedberg","Comedy, Adventure, Fantasy","l0lGJiTzU2Ce6T31DIRWv7I0kaC.jpg",9760],["Goal!",2005,2.5,1,"Danny Cannon","Drama","9YZhJGoIbJtrjDYbENGhR6f6SZE.jpg",9763],["Dersu Uzala",1975,3.5,1,"Akira Kurosawa","Adventure, Drama","bIOrDQ3Gg68k3qJAnRU7nIZr0BW.jpg",9764],["Cry-Baby",1990,4.5,1,"John Waters","Comedy, Romance","d2QusoWfW4azJtHtJkyLMGSv33n.jpg",9768],["Air Force One",1997,2.5,1,"Wolfgang Petersen","Action, Thriller","evO1iENjLpUnbwjnt5XK85jRYob.jpg",9772],["Art School Confidential",2006,3.5,1,"Terry Zwigoff","Comedy, Drama","eV6UL22Zlpsq5XybUupWh0rBOp0.jpg",9786],["The Fast and the Furious",2001,2,1,"Rob Cohen","Action, Crime, Thriller","gqY0ITBgT7A82poL9jv851qdnIb.jpg",9799],["Philadelphia",1993,4,1,"Jonathan Demme","Drama","tFe5Yoo5zT495okA49bq1vPPkiV.jpg",9800],["The Rock",1996,3.5,1,"Michael Bay","Action, Adventure, Thriller","eBcoxveWzzXQrCrwWMGAROcqgpP.jpg",9802],["The Incredibles",2004,4,3,"Brad Bird","Action, Adventure, Animation, Family","2LqaLgk4Z226KkgPJuiOQ58wvrm.jpg",9806],["Goal II: Living the Dream",2007,1.5,1,"Jaume Collet-Serra","Drama","ih87q15J13ntUPsLvNNO9nGsRtn.jpg",9815],["Marvin's Room",1996,2,1,"Jerry Zaks","Drama","lTHq1K5Y6EDRjxTBvReXHY6AKQ3.jpg",9819],["The Parent Trap",1998,4,1,"Nancy Meyers","Comedy, Family, Romance","dNqgjqxHIdfsQRQL5XTujNfX9pj.jpg",9820],["Mighty Joe Young",1998,2,1,"Ron Underwood","Adventure, Family, Action, Fantasy","jM39MOyLOxCD6Njz4vfQkGaKkY1.jpg",9822],["Lake Placid",1999,1,1,"Steve Miner","Horror, Comedy, Action, Science Fiction, Thriller","pEszakCP8j9E9S0UPLfEa3Cad3O.jpg",9825],["United 93",2006,4,1,"Paul Greengrass","Drama, History, Crime, Thriller, Action","r3mdSgsnpoi4UiUufdybhjha68t.jpg",9829],["Jane Austen's Mafia!",1998,2,1,"Jerry Zucker & David Zucker & Jim Abrahams","Comedy, Crime","gGgirOcInrfjWgemKMjvZc3fGtU.jpg",9835],["Happy Feet",2006,3.5,2,"George Miller","Animation, Comedy, Family","za41IHkj6LnkilfTzv5B2qmthKD.jpg",9836],["The Prince of Egypt",1998,3,1,"Simon Wells","Adventure, Animation, Drama, Family","2xUjYwL6Ol7TLJPPKs7sYW5PWLX.jpg",9837],["Beyond",2003,3.5,1,"Martin Campbell","Drama, Romance, Adventure, War","j7Upm2AtGuTzCs2Asq0GyBIMAxX.jpg",9839],["To Live and Die in L.A.",1985,3,1,"William Friedkin","Crime, Thriller, Action","2iW3pSihBIhXjnBQmUJ0mAiZbB5.jpg",9846],["My Favorite Martian",1999,1,1,"Donald Petrie","Comedy, Family, Science Fiction","pOp4xriDEFUy2uN0BfnHJcjzqWt.jpg",9849],["The Princess Diaries",2001,2.5,1,"Garry Marshall","Comedy, Family, Romance","qSw4lzhDGeM5MjQc86BLzJALhBs.jpg",9880],["Shallow Hal",2001,1.5,1,"Peter Farrelly & Bobby Farrelly","Comedy, Drama, Fantasy, Romance","q4lZrHWTWuybb6pzMucj1c0ngCW.jpg",9889],["The Stepford Wives",2004,2,1,"Frank Oz","Comedy, Science Fiction, Horror","ygr0Wlmm1KmE16TUefNitIscVBG.jpg",9890],["The Cable Guy",1996,3.5,1,"Ben Stiller","Comedy, Drama, Thriller","YJt9l3RdrRohI95btQKPXwpdii.jpg",9894],["Rat Race",2001,2,1,"Jerry Zucker & David Zucker & Jim Abrahams","Adventure, Comedy","8ghNCfFbCJjcNSz2K5jOC3eO6ZD.jpg",9896],["The Producers (2005)",2005,2,1,"Susan Stroman","Comedy","nG0Bix2SH2SQcbAIGhb6yqTG5UH.jpg",9899],["Shallow Grave",1994,3,1,"Danny Boyle","Crime, Thriller","gqvSKLbfIg1mja1ulVkVcLhdwWF.jpg",9905],["The Ant Bully",2006,2,1,"John A. Davis","Fantasy, Adventure, Animation, Comedy, Family","oFuqX0inTvbA1XAFv2x3CQnI65m.jpg",9906],["Barnyard",2006,2,1,"Steve Oedekerk","Animation, Comedy, Family","qB9jFInwUEb2VLhMeKQX17Vdrnp.jpg",9907],["How to Lose a Guy in 10 Days",2003,2.5,1,"Donald Petrie","Comedy, Romance","2dlftyPz7mTYbrsPvTogyFmYd7d.jpg",9919],["Ultraviolet",2006,1,1,"Kurt Wimmer","Science Fiction, Action, Thriller","27OzQ2BBahQHYPiPEAXRXMbhnPQ.jpg",9920],["Robots",2005,2.5,1,"Chris Wedge","Animation, Comedy, Family, Science Fiction","fnKCh67l2DDG9NxxIlk9IpsXQ99.jpg",9928],["Analyze That",2002,1.5,1,"Harold Ramis","Comedy, Crime","q3R6Hno3WFfIkHQg7CeVAEOcHQQ.jpg",9932],["The Fox and the Hound 2",2006,1.5,1,"Jim Kammerud","Adventure, Animation, Comedy, Family","o3b8nenAzu5OJk7sbPJURwmeHSV.jpg",9948],["Lord of the Flies",1963,3,1,"Peter Brook","Drama, Adventure, Thriller","3jhp9oxZpwcWCZ1vfn3PyMWovzq.jpg",9960],["Bad Taste",1987,3,1,"Peter Jackson","Action, Comedy, Horror, Science Fiction","msttMX3undIiaeJLZbMRq94v1bw.jpg",9964],["Deck the Halls",2006,1.5,1,"John Whitesell","Comedy, Family","smJDzhYGhl6j9OrucsB7IkMNy82.jpg",9969],["Kicking & Screaming",2005,1.5,1,"Jesse Dylan","Family, Comedy","4erPZ5V0yzNXRB2IcypOACMEgOA.jpg",9981],["Chicken Little",2005,1.5,1,"Mark Dindal","Animation, Family, Comedy","87FpA4b90eTaw3U6zmCNikoPLir.jpg",9982],["Charlotte's Web",2006,2.5,1,"Gary Winick","Comedy, Family, Fantasy","fU0IR5HF8KxQbZijuWKPTrY81Qv.jpg",9986],["The Great Mouse Detective",1986,3,1,"John Musker & Ron Clements","Animation, Family, Mystery, Crime, Adventure","9uDr7vfjCFr39KGCcqrk44Cg7fQ.jpg",9994],["The Strategy of the Snail",1993,3.5,1,"Sergio Cabrera","Comedy, Drama","ncBseACi28qHeIytvYJdQvnIS4P.jpg",10000],["Brother Bear",2003,3,1,"Aaron Blaise","Adventure, Animation, Family","otptPbEY0vBostmo95xwiiumMJm.jpg",10009],["Brother Bear 2",2006,2,1,"Ben Gluck","Adventure, Animation, Family","yaA8q2zHHUgFWdJNxXyAdU71SzM.jpg",10010],["Peggy Sue Got Married",1986,2.5,1,"Francis Ford Coppola","Comedy, Drama, Fantasy","tfuQcvQmURiMqB2VPwytU3cPpEm.jpg",10013],["A Nightmare on Elm Street Part 2: Freddy's Revenge",1985,2,1,"Jack Sholder","Horror","53kxYw0G3o55yJ23K7s7KMaOyAM.jpg",10014],["Beauty and the Beast (1991)",1991,3.5,1,"Gary Trousdale & Kirk Wise","Romance, Family, Animation, Fantasy","hUJ0UvQ5tgE2Z9WpfuduVSdiCiU.jpg",10020],["The Pacifier",2005,3,1,"Adam Shankman","Comedy, Family, Action","ayVLPibrtazh7U5FliWRLDMmG3d.jpg",10022],["Miss Congeniality 2: Armed and Fabulous",2005,1.5,1,"John Pasquin","Action, Comedy","gcYoIHND3ugn2VH1cNHHNQasEyI.jpg",10040],["Joan of Arc",2002,2,1,"Luc Besson","Adventure, Drama, Action, History, War","lFzOGA2LPdOfQyhEiY74uDf2WKa.jpg",10047],["Spy Kids",2001,3,1,"Robert Rodriguez","Family, Action, Comedy, Adventure, Science Fiction","j3rUkHIAAoKr6jU30q3Db4fcIF9.jpg",10054],["Killer's Kiss",1955,2.5,1,"Stanley Kubrick","Thriller, Crime, Drama","rLbad0lscycS4R3qTSrKguZ0Zz5.jpg",10056],["The Shaggy Dog",2006,1,1,"Brian Robbins","Comedy, Family","tGX3YyPaYMbjiRwR5PjRsJW7GtM.jpg",10067],["A Nightmare on Elm Street 3: Dream Warriors",1987,3.5,1,"Chuck Russell","Horror, Thriller, Fantasy","qbtZewU6EGvxi8yFVzwZ31NijLX.jpg",10072],["Hot Rod",2007,2.5,1,"Akiva Schaffer","Comedy, Action","jRkt03dXCVKnbvcQm3ygU1cjg9Y.jpg",10074],["Man Bites Dog",1992,2,1,"Rémy Belvaux","Comedy, Crime","uRVI98a6MxdLkpsXM8LqIM9W7XZ.jpg",10086],["The Return (2006)",2006,1,1,"Asif Kapadia","Horror, Drama, Thriller","rCzpDGLbOoPwLjy3OAm5NUPOTrC.jpg",10093],["13 Going on 30",2004,2.5,1,"Gary Winick","Comedy, Fantasy, Romance","iNZdSIfhSCMtRILDNyhLn8UKeSG.jpg",10096],["The Kid",1921,4,1,"Charlie Chaplin","Comedy, Drama","A9NWYyn7eX0H9XIjaOvfWJ9mCGA.jpg",10098],["Empire of the Sun",1987,3.5,1,"Steven Spielberg","Drama, History, War","gEaCzjwHoPgyQFcwHql7o5YLHAU.jpg",10110],["The Aristocats",1970,3.5,1,"Wolfgang Reitherman","Animation, Comedy, Family, Adventure","1BVOSmQUhphMgnTxnXyfQ9tL1Sc.jpg",10112],["Fine Dead Girls",2002,2.5,1,"Dalibor Matanić","Thriller, Drama","jmeTpxg27eqtCTrUl237yaW2rT1.jpg",10125],["A Nightmare on Elm Street 4: The Dream Master",1988,2.5,1,"Renny Harlin","Horror, Thriller","boStYG7jKdoIZTduiOOsUVknD13.jpg",10131],["Stuart Little",1999,2,1,"Roger Allers & Rob Minkoff","Family, Fantasy, Comedy, Adventure","362lcwTJlNyAhitTlp2UraECISR.jpg",10137],["Iron Man 2",2010,2.5,1,"Jon Favreau","Adventure, Action, Science Fiction","6WBeq4fCfn7AN0o21W9qNcRF2l9.jpg",10138],["Milk",2008,3.5,1,"Gus Van Sant","History, Drama","ot4ImF4b7QbS6XsTdMH3pWxNmX2.jpg",10139],["The Chronicles of Narnia: The Voyage of the Dawn Treader",2010,2,1,"Michael Apted","Adventure, Family, Fantasy","pP27zlm9yeKrCeDZLFLP2HKELot.jpg",10140],["Dirty Rotten Scoundrels",1988,3.5,1,"Frank Oz","Comedy, Crime","3176xH21fSetstKpEtAD1giHbyT.jpg",10141],["The Little Mermaid",1989,3,1,"John Musker & Ron Clements","Animation, Family, Fantasy","plcZXvI310FkbwIptvd6rqk63LP.jpg",10144],["Bad Santa",2003,3.5,1,"Terry Zwigoff","Drama, Comedy, Crime","rfClLIyeHqpMofmrPY8DaLe4z9x.jpg",10147],["Smoke",1995,3.5,1,"Wayne Wang","Comedy, Drama","1WMUaTQaj2dQrhsPI3Px0OR9eTF.jpg",10149],["History of the World: Part I",1981,2,1,"Mel Brooks","Comedy","6iAl78qZHT65erPXr2YW6Y54wlY.jpg",10156],["A Nightmare on Elm Street: The Dream Child",1989,2,1,"Stephen Hopkins","Horror, Thriller","kizvpgXQfrAgN8FhOd87LbKk6kO.jpg",10160],["My Left Foot: The Story of Christy Brown",1989,4,1,"Jim Sheridan","Drama","GRAAl0bMQFoFIjV3aunc5jsM5u.jpg",10161],["Fear and Desire",1952,1.5,1,"Stanley Kubrick","Drama, War, Thriller","mj7CDh6d5nJDDmEhd0ft6s3L8CM.jpg",10165],["The Witches",1990,3,1,"Nicolas Roeg","Fantasy, Family, Horror","mPYBjVkeHakkPGY7WaKyyNU4RWm.jpg",10166],["Are We Done Yet?",2007,0.5,1,"Steve Carr","Family, Comedy","uZ9NZh4zB80phMxo5PucFyWagjG.jpg",10172],["The Rocker",2008,2,1,"Peter Cattaneo","Comedy, Music","wzgFC7jOEMtf9D6CSdI7ckUMtwU.jpg",10186],["Pineapple Express",2008,2.5,1,"David Gordon Green","Action, Comedy, Crime","6E50WjeOYjDZg9HXgPjYdGtY2jG.jpg",10189],["How to Train Your Dragon",2010,3.5,1,"Chris Sanders & Dean DeBlois","Fantasy, Adventure, Animation, Family","ygGmAO60t8GyqUo9xYeYxSZAR3b.jpg",10191],["Shrek Forever After",2010,2,3,"Mike Mitchell","Comedy, Adventure, Fantasy, Animation, Family","6HrfPZtKcGmX2tUWW3cnciZTaSD.jpg",10192],["Toy Story 3",2010,4,2,"Lee Unkrich","Animation, Family, Comedy","AbbXspMOwdvwWZgVN0nabZq03Ec.jpg",10193],["Thor",2011,2.5,1,"Kenneth Branagh","Adventure, Fantasy, Action","prSfAi1xGrhLQNxVSUFh61xQ4Qy.jpg",10195],["The Last Airbender",2010,0.5,1,"M. Night Shyamalan","Action, Adventure, Fantasy","kl9JJ8288bNsY8oqT1SpQh1w2mb.jpg",10196],["The Princess and the Frog",2009,2.5,1,"John Musker & Ron Clements","Animation, Romance, Fantasy, Family","yprv5PbnEksoVj2v6XEnDBg9joR.jpg",10198],["The Day the Earth Stood Still (2008)",2008,1,1,"Scott Derrickson","Drama, Science Fiction, Thriller","vBgFSYmG5tb7GsZ3tHR0WNaWaxA.jpg",10200],["Yes Man",2008,2,1,"Peyton Reed","Comedy, Romance","8Vk2nQF1kY34x53YnWd5zDaTht.jpg",10201],["Bedtime Stories",2008,1.5,1,"Adam Shankman","Fantasy, Comedy, Family, Romance","2PljsqbhxrFUzfTnaVhsseHhXN0.jpg",10202],["Around the World in 80 Days",2004,2,1,"Frank Coraci","Action, Adventure, Comedy","bBiMw6Jtg8tSTcEq8jFV7qk9TRW.jpg",10204],["Son of the Mask",2005,0.5,1,"Lawrence Guterman","Fantasy, Comedy, Family, Adventure","Adgnfhm9B8YAQmC0osuP4zO9SRc.jpg",10214],["PlayTime",1967,3.5,1,"Jacques Tati","Comedy","oUXEJLgDfAFR6TvJU6dMerEpcBK.jpg",10227],["Pokémon: The First Movie",1998,2.5,1,"Kunihiko Yuyama","Animation, Family, Adventure, Fantasy, Action","6YPzBcMH0aPNTvdXNCDLY0zdE1g.jpg",10228],["Funny Games",1997,5,1,"Michael Haneke","Drama, Horror, Thriller","vUJxLlRGM6KfXQDeAHqyMyhrI59.jpg",10234],["Alexander Nevsky",1938,2.5,1,"Sergei Eisenstein","Drama, History, War","qoXoIx4oCyxQ7dYbp2vBB6uPYOF.jpg",10235],["Cries and Whispers",1972,5,2,"Ingmar Bergman","Drama","a1bMgB09YDvvRN9SitCclUYragr.jpg",10238],["What Ever Happened to Baby Jane?",1962,4,1,"Robert Aldrich","Drama, Horror, Thriller","msGYzyWwtjAaA3DScdgmvJ5MReG.jpg",10242],["What About Bob?",1991,3.5,1,"Frank Oz","Comedy","pFCrGGGhV5xeAdvEysv6aSv8T13.jpg",10276],["Fido",2006,3,1,"Andrew Currie","Horror, Comedy, Romance, Drama","hKUUn6f4Hxj5iqQKMlQzRqbg2yT.jpg",10288],["How to Marry a Millionaire",1953,2,1,"Jean Negulesco","Comedy, Romance","dFwefYyEOOZaWVn15xGY6CbYYJ2.jpg",10297],["Patch Adams",1998,2,1,"Tom Shadyac","Comedy, Drama","xN1aKur5ddWQSXTqvzDPJD2TCxe.jpg",10312],["Fantastic Mr. Fox",2009,4,2,"Wes Anderson","Adventure, Animation, Comedy, Family","euZyZb6iGreujYKrGyZHRddhUYh.jpg",10315],["The Ides of March",2011,3.5,1,"George Clooney","Drama","w8t4UnJnC24S9ygoaFgmMzRbErd.jpg",10316],["Being There",1979,4.5,1,"Hal Ashby","Comedy, Drama","3RO3jbCKEey2T9bYFkYt9xpwen9.jpg",10322],["Clash of the Titans",1981,2.5,1,"Desmond Davis","Adventure, Fantasy, Action","5JCLODNLJH6alc3KmyoiC21Nlob.jpg",10323],["Legally Blonde 2: Red, White & Blonde",2003,1.5,1,"Charles Herman-Wurmfeld","Comedy, Romance","4kC0UGTuJgFnlZq2ZM6OiY7nuY8.jpg",10327],["Freaky Friday",2003,3.5,1,"Mark Waters","Comedy, Family, Fantasy","ipKcZ4Up7dp18XpsfYUc9NKZy3g.jpg",10330],["Night of the Living Dead",1968,3.5,1,"George A. Romero","Horror, Thriller, Science Fiction","rb2NWyb008u1EcKCOyXs2Nmj0ra.jpg",10331],["The Prince of Tides",1991,2.5,1,"Barbra Streisand","Drama, Romance","1AyeW3YlwfhRwLDeUCW686obceb.jpg",10333],["Lady and the Tramp",1955,3,1,"Clyde Geronimi, Wilfred Jackson y Hamilton Luske","Animation, Family, Romance, Adventure, Comedy","340NcWz9SQXWQyf4oicMxjbrLOb.jpg",10340],["Zack and Miri Make a Porno",2008,2.5,1,"Kevin Smith","Comedy, Romance","ipePhKf87FixwfAVJ8MMWK53caI.jpg",10358],["Hunger",2008,4,1,"Steve McQueen","Drama, History","84HdTM39G2MzyTl8N9R0wVU9I5b.jpg",10360],["My Cousin Vinny",1992,3.5,1,"Jonathan Lynn","Comedy, Drama","iwSURa8nS2ujwrU3s1lfxxX7voH.jpg",10377],["The Iron Giant",1999,3.5,1,"Brad Bird","Animation, Drama, Family, Science Fiction, Action, Adventure","ct04FCFLPImNG5thcPLRnVsZlmS.jpg",10386],["The Limey",1999,4,1,"Steven Soderbergh","Crime, Drama, Thriller, Mystery","efAnFInZYrenNvBlLIXN2oLYyNc.jpg",10388],["The Player",1992,4.5,1,"Robert Altman","Mystery, Drama, Thriller, Comedy, Crime","tZ3kDut2dhFVGkWNEn9xoCHCNAx.jpg",10403],["Raise the Red Lantern",1991,5,1,"Zhang Yimou","Drama","j6MGZpg55cTqlHHwahBtzI2qQg1.jpg",10404],["Encino Man",1992,1.5,1,"Les Mayfield","Comedy","y8HtL6pyjfODdHOFgciFVFmt8Eq.jpg",10406],["The Age of Innocence",1993,4,1,"Martin Scorsese","Drama, Romance","5Tuyt26v7qNR8Cl3m7ZRx36rduf.jpg",10436],["The Muppet Christmas Carol",1992,3.5,1,"Brian Henson","Music, Comedy, Family, Fantasy, Drama","ssrV29QSVVJuemBHho0Qx7pFYak.jpg",10437],["Hocus Pocus",1993,2.5,1,"Kenny Ortega","Fantasy, Comedy, Family","by4D4Q9NlUjFSEUA1yrxq6ksXmk.jpg",10439],["Manhattan Murder Mystery",1993,3.5,1,"Woody Allen","Comedy, Mystery","zrzBIlMyAP7Ac9W5qAy5ssAUdK4.jpg",10440],["Fearless",1993,4,1,"Peter Weir","Drama","sFhzvwgv04VUmedB7pOO4cMP9xq.jpg",10443],["Eat Drink Man Woman",1994,4.5,1,"Ang Lee","Comedy, Drama, Romance","ktdCBg2Xq2Ry0fuJYT4izktM2Hg.jpg",10451],["The Money Pit",1986,1.5,1,"Richard Benjamin","Comedy, Romance","bohhidIi1WWU5NNYF9l5wLQu3Ii.jpg",10466],["Driven",2001,1,1,"Renny Harlin","Action, Drama","8tJ4Ya8yEyxCMihDumEyvwvUuLB.jpg",10477],["102 Dalmatians",2000,2,1,"Kevin Lima","Family, Comedy","ueE6u2GTECzGBtas6PFx7wwi9y0.jpg",10481],["Perfect Blue",1997,5,2,"Satoshi Kon","Animation, Thriller","6WTiOCfDPP8XV4jqfloiVWf7KHq.jpg",10494],["The Road to El Dorado",2000,3,1,"Bibo Bergeron","Family, Adventure, Animation, Comedy, Fantasy","ryXm7xp4aqQyda0FU2eMfHehPBg.jpg",10501],["Happy-Go-Lucky",2008,4.5,1,"Mike Leigh","Comedy, Drama","9FdD4YClMPZponkvHuQOgEOaWcF.jpg",10503],["Plan 9 from Outer Space",1957,1,1,"Edward D. Wood Jr.","Science Fiction, Horror","bmicZi7PvlnZ9rZqp6QXN2Db0pT.jpg",10513],["Castle in the Sky",1986,3.5,1,"Hayao Miyazaki","Adventure, Fantasy, Animation, Action, Family","41XxSsJc5OrulP0m7TrrUeO2hoz.jpg",10515],["Madagascar: Escape 2 Africa",2008,1.5,1,"Eric Darnell & Tom McGrath","Adventure, Animation, Comedy, Family","agRbLOHgN46TQO4YdKR462iR7To.jpg",10527],["Sherlock Holmes",2009,3.5,2,"Guy Ritchie","Action, Adventure, Mystery","zz0vClg5NdYbhpqaEGyJENrGVSw.jpg",10528],["Pocahontas",1995,2.5,1,"Mike Gabriel","Adventure, Animation, Family, Romance","kZ1ft0QZ4e3zDUPMBftEkwI9ftd.jpg",10530],["James and the Giant Peach",1996,3,1,"Henry Selick","Family, Animation, Adventure, Fantasy","vNEGobe23vW43mSPYVaVaBLP6qV.jpg",10539],["The Hunchback of Notre Dame",1996,3.5,1,"Gary Trousdale & Kirk Wise","Drama, Animation, Family","7k0fr2xLCTChjN8MnGNThTP9uEB.jpg",10545],["Shark Tale",2004,1.5,1,"Vicky Jenson","Animation, Action, Comedy, Family","r08DpyPyhXcJTfNZAICNGMzcQ8l.jpg",10555],["Dinosaur",2000,2,1,"Eric Leighton","Adventure, Animation, Drama, Family","rSje3FS7ycJSglowlngjsvDt7vO.jpg",10567],["Psycho II",1983,3.5,1,"Richard Franklin","Horror, Mystery, Thriller","sJAPRj3vHmjV4z97YK84iDovYlm.jpg",10576],["Child's Play",1988,3,1,"Tom Holland","Horror","7jrOhGtRh6YK7sMfvH1E1f36aVx.jpg",10585],["The Cat in the Hat",2003,1,1,"Bo Welch","Fantasy, Adventure, Family, Comedy","uYYLz67e5xEQMsY858VSSCDsLU6.jpg",10588],["Pinocchio (2002)",2002,1,1,"Roberto Benigni","Comedy, Family, Fantasy","aN2Pa9FnbJA2g4mnHPCWajwtdQ4.jpg",10599],["Peter Pan (2003)",2003,2.5,1,"P.J. Hogan","Adventure, Fantasy, Family","6QdU3TZZrIvXFzoHOwafZAynFjB.jpg",10601],["George of the Jungle",1997,2.5,1,"Sam Weisman","Adventure, Comedy, Family, Romance","lWp8hUqE4oLPxsYgilXoYoVThfU.jpg",10603],["The Medallion",2003,2,1,"Gordon Chan","Thriller, Fantasy, Action, Comedy","lbjFWKfe8WdS8Pj6WVPlyEKeVEo.jpg",10610],["Mean Girls",2004,4,1,"Mark Waters","Drama, Comedy","2ZkuQXvVhh45uSvkBej4S7Ix1NJ.jpg",10625],["Kangaroo Jack",2003,1,1,"David McNally","Adventure, Comedy, Crime, Family","nflh9On0de4l7ItCl3n4NVXjmnm.jpg",10628],["In the Heat of the Night",1967,3.5,1,"Norman Jewison","Crime, Drama, Mystery, Thriller","1zjS7aSgvOX98BSWEsshDw3kxe5.jpg",10633],["The Seven Year Itch",1955,2,1,"Billy Wilder","Comedy, Romance","4oLqx0QbjWFzWtkxRmDLGH47CUJ.jpg",10653],["Hair",1979,2.5,1,"Miloš Forman","Music, Drama, Comedy","z0ctToyPWCB2RgIkMpD6RhRKAeH.jpg",10654],["Deliverance",1972,4,1,"John Boorman","Drama, Adventure, Thriller","2TrAzNJlHyNYYSkQf6asg3rs2Xr.jpg",10669],["Mulan",1998,4,3,"Barry Cook","Animation, Family, Adventure","jAbexAtB0aSfP5Ay4TpWHARyVnG.jpg",10674],["Halloween III: Season of the Witch",1982,3,1,"Tommy Lee Wallace","Horror, Science Fiction, Mystery, Thriller","WABfdeaThFYXCySGIOvRNv2sSW.jpg",10676],["WALL·E",2008,5,3,"Andrew Stanton","Animation, Family, Science Fiction","hbhFnRzzg6ZDmm8YAmxBnQpQIPh.jpg",10681],["Happiness",1998,4.5,1,"Todd Solondz","Comedy, Drama","rYfUcEV88Z3gENrfYTE6i8yBkDr.jpg",10683],["Peter Pan",1953,3.5,1,"Clyde Geronimi, Wilfred Jackson y Hamilton Luske","Animation, Family, Adventure, Fantasy","fJJOs1iyrhKfZceANxoPxPwNGF1.jpg",10693],["The Squid and the Whale",2005,4,1,"Noah Baumbach","Comedy, Drama","9NbXn1NMdfGM491V3EFjZADR9SX.jpg",10707],["Daddy Day Care",2003,3,1,"Steve Carr","Comedy, Family","uiey5XUKuPicwpIJMf1OpaOd1jL.jpg",10708],["Far from Heaven",2002,4,1,"Todd Haynes","Drama, Romance","9gQuvFDRPLx39smUvyafm36tp0d.jpg",10712],["Looney Tunes: Back in Action",2003,2.5,1,"Joe Dante","Animation, Comedy, Family","q0kntpdsHA0QdYjpQdNBqrVTdQq.jpg",10715],["Elf",2003,2.5,1,"Jon Favreau","Comedy, Family, Fantasy","oOleziEempUPu96jkGs0Pj6tKxj.jpg",10719],["The Day of the Beast",1995,3.5,1,"Álex de la Iglesia","Horror, Comedy, Action","yEXhgACPIV4PmTgHT2HS3Ko2oS3.jpg",10722],["Faust",1926,3,1,"F. W. Murnau","Fantasy, Drama, Horror","rN703hMFxmkZfyEzsXvFtuFhkXE.jpg",10728],["Escape from Alcatraz",1979,3.5,1,"Don Siegel","Drama, Thriller","uORr2GXQnyqgBOg6tVsRCJD2qxc.jpg",10734],["Anything Else",2003,3,1,"Woody Allen","Drama, Comedy, Romance","bvyoWDh60R31ZE5L8TjZ8Qpv5xM.jpg",10739],["Birth",2004,3,1,"Jonathan Glazer","Drama, Mystery","g4EeAqrwvi2rIC9bt9pCiiLE2Xp.jpg",10740],["Police Story 2",1988,3.5,1,"Jackie Chan","Action, Crime, Thriller","kjq1FXtHh9i2sIuM0JaoYf43FDU.jpg",10753],["A Short Film About Killing",1988,4,1,"Krzysztof Kieślowski","Crime, Drama","k7sk4yNdoXY7iwp1M9QTZuBDiJS.jpg",10754],["The Haunted Mansion",2003,1,1,"Roger Allers & Rob Minkoff","Thriller, Fantasy, Comedy, Family, Mystery","lGi5yio4pdDz5PkSeZCbnMQz5vK.jpg",10756],["Quantum of Solace",2008,2.5,1,"Marc Forster","Adventure, Action, Thriller","e3DXXLJHGqMx9yYpXsql1XNljmM.jpg",10764],["The Tuxedo",2002,2.5,1,"Kevin Donovan","Thriller, Action, Comedy, Science Fiction","lTMnOx7E2zEzIGY0og1KkfgYMhY.jpg",10771],["Django",1966,3.5,1,"Sergio Corbucci","Action, Western","vs4vieNstSEfbgLFEelXXOPvr6h.jpg",10772],["Network",1976,4.5,2,"Sidney Lumet","Drama","qZomlHsaALUtkFeMDwdYmwS2Pbo.jpg",10774],["Infernal Affairs",2002,3,1,"Alan Mak Siu-Fai","Drama, Action, Thriller, Crime, Mystery","gix9thDBXfjJ8M7rYbihqbQGBcP.jpg",10775],["Little Shop of Horrors",1986,5,6,"Frank Oz","Horror, Comedy","iKkbN17OmFosaW6asCNZTTsyvpu.jpg",10776],["The Man Who Wasn't There",2001,4.5,1,"Joel Coen & Ethan Coen","Crime, Drama","lrCgt8NNMyFsfmXyXiSSCRXNH4u.jpg",10778],["The Frighteners",1996,3.5,1,"Peter Jackson","Horror, Comedy","zcJbCMwFLJdn5OLjhYwMVaSB32R.jpg",10779],["Cabaret",1972,3,2,"Bob Fosse","Music, Romance, Drama","fMhOeJ2TvuY46iYGmsowhgRXfnr.jpg",10784],["The Thing from Another World",1951,2,1,"Christian Nyby","Drama, Horror, Science Fiction","rm2w8dEhOGDuckB6i0Spz9lTzpR.jpg",10785],["The Invisible Man",1933,3,1,"James Whale","Horror, Science Fiction","ewfUA5pMEJrmQCdI4TsHmLlIUbf.jpg",10787],["The One",2001,1,1,"James Wong","Action, Science Fiction, Thriller","gcr3t71KmeXINemMrhaGBGVJPwW.jpg",10796],["Showgirls",1995,2.5,1,"Paul Verhoeven","Drama","o4HT3Ap5c99W4FYpdXUtTvxGgPc.jpg",10802],["Dr. Dolittle 2",2001,1.5,1,"Steve Carr","Comedy, Family, Romance, Fantasy","asYjHXBoD44B6mLOcZtMfMV3hm1.jpg",10808],["Water Lilies",2007,4,1,"Céline Sciamma","Drama, Romance","oNrs9disgGDtOORToDt5dIqYFBi.jpg",10818],["Matilda",1996,3.5,1,"Danny DeVito","Comedy, Family, Fantasy","wYoDpWInsBEVSmWStnRH06ddoyk.jpg",10830],["After Hours",1985,4.5,2,"Martin Scorsese","Comedy, Thriller, Drama","eamOBurHBu0MIxohTIVcfxmZ6Z7.jpg",10843],["The Purple Rose of Cairo",1985,4,2,"Woody Allen","Fantasy, Comedy, Romance","ccsint43E44B7NGceEhVimD93Yt.jpg",10849],["Atlantis: The Lost Empire",2001,3,1,"Gary Trousdale & Kirk Wise","Animation, Family, Adventure, Science Fiction","rdCyK9hgoA2vYrLtVFpDc3KWBaC.jpg",10865],["Shadow of the Vampire",2000,3,1,"E. Elias Merhige","Drama, Horror","nWm7DWi8X4D87XkM5qr9BhTJHq6.jpg",10873],["Sleeping Beauty",1959,3,1,"Clyde Geronimi","Fantasy, Animation, Romance, Family","n3pxoMDDxp10c1smgbDzW4bwlzq.jpg",10882],["Pinocchio",1940,3.5,1,"Ben Sharpsteen","Animation, Family, Fantasy","bnZJrLRnoQHpzEJdka1KYfsAF3N.jpg",10895],["The Little Mermaid II: Return to the Sea",2000,1.5,1,"Jim Kammerud","Animation, Adventure, Family, Comedy","k3UHxvYv8ZgWLL0lM45f979OSo7.jpg",10898],["The Adventures of Robin Hood",1938,3.5,1,"Michael Curtiz","Adventure, Romance, Action","4mazyXEMkmLw5h6076yyNSm9uv0.jpg",10907],["Agent Cody Banks",2003,1.5,1,"Harald Zwart","Action, Adventure, Comedy, Family","fhK0mqqirPsckxkNisvi32A4lf6.jpg",10923],["The Return of the Living Dead",1985,3.5,1,"Dan O'Bannon","Comedy, Horror, Science Fiction","oNsV9BychAe4Sk6xFKp558Rlpyz.jpg",10925],["Under the Tuscan Sun",2003,2.5,1,"Audrey Wells","Romance, Comedy","3vQUQwdtfPt1Sl2GZrIECWWA0dk.jpg",10934],["In the Cut",2003,3.5,1,"Jane Campion","Drama, Mystery, Thriller, Romance","c8Xg0yc8UQwDXooffBNLLs2BvQH.jpg",10944],["High School Musical",2006,2.5,1,"Kenny Ortega","Comedy, Family, TV Movie, Music, Romance","1DGmWZjUJPeKGFRHGCA6VPFUBML.jpg",10947],["The Fox and the Hound",1981,3,1,"Richard Rich","Adventure, Animation, Drama, Family","aC3k6XBaYnulGSkK8263ABjU3Md.jpg",10948],["Oliver Twist",1948,3.5,1,"David Lean","Drama, Adventure, Crime, Comedy","bZnv0qWxuuo8gR2FVJ0QtoBtuvh.jpg",10949],["I Am Sam",2001,3,1,"Jessie Nelson","Drama","3MUXRSyx9gnA2lLSSTGLN8cQQ42.jpg",10950],["Creature from the Black Lagoon",1954,3,1,"Jack Arnold","Adventure, Horror, Science Fiction","euCzA2Exc70MpTDCVYih8tdE7z1.jpg",10973],["Hoodwinked!",2005,1,1,"Cory Edwards","Animation, Comedy, Crime, Family, Mystery","kwPl1AKX4BLxrh5PCkrwYWeEV5I.jpg",10982],["Halloween: The Curse of Michael Myers",1995,1.5,1,"Joe Chappelle","Horror, Thriller","noCnM8nEI2bEDSdKHh0RKbwBwbC.jpg",10987],["Pokémon 3: The Movie",2000,1.5,1,"Kunihiko Yuyama","Adventure, Fantasy, Animation, Action, Family","hrBWiMWnD7mheMx846ycUWA3ohs.jpg",10991],["Cats & Dogs",2001,1,1,"Lawrence Guterman","Family, Comedy, Action, Adventure, Fantasy","wUWoat7L4vvQburQ8pVEJhRG9L5.jpg",10992],["Stuart Little 2",2002,1.5,1,"Roger Allers & Rob Minkoff","Family, Adventure, Comedy","hjfeMLWqJY44mqqJKZSa6jx4Y1j.jpg",10996],["Fatal Attraction",1987,3.5,1,"Adrian Lyne","Thriller, Drama, Romance","vjB9XwJKnYqFKKjhWcE6WpAf5Ki.jpg",10998],["Commando",1985,3.5,1,"Mark L. Lester","Action, Adventure, Thriller","ollPAAAgZ7euU8VisfqU3cuXhZ6.jpg",10999],["The Birdcage",1996,3.5,1,"Mike Nichols","Comedy, Romance","hU2XeckncHS61TWZKDtw1BrKmOO.jpg",11000],["Awakenings",1990,3.5,1,"Penny Marshall","Drama","9gztZXuHLG6AJ0fgqGd7Q43cWRI.jpg",11005],["Cheaper by the Dozen",2003,2,1,"Shawn Levy","Comedy, Family, Drama","afclGGoQslTYFTnyW1LRMtJMiBp.jpg",11007],["Saturday Night Fever",1977,3,1,"John Badham","Drama","ylA7E5Md21aqgzxbwa2dFxX8LKV.jpg",11009],["Ri¢hie Ri¢h",1994,1.5,1,"Donald Petrie","Comedy, Family","qgGh5d0IHAZRlHIdFS3XWVygumR.jpg",11011],["Secretary",2002,3.5,1,"Steven Shainberg","Romance, Drama, Comedy","mdRXSE7ho185SZlXj0JSwuecEd3.jpg",11013],["Billy Madison",1995,2.5,1,"Tamra Davis","Comedy","sOdgtJdFalL9kRKaeJItARLTAEq.jpg",11017],["Picnic at Hanging Rock",1975,3.5,1,"Peter Weir","Drama, Mystery","7BAXwmFN4pZDNb9N6kzmAAwdssi.jpg",11020],["Scooby-Doo 2: Monsters Unleashed",2004,2,1,"Raja Gosnell","Mystery, Adventure, Comedy","5BrXCJrs22bR5KR6mLHluYo6y4m.jpg",11024],["New York Minute",2004,1.5,1,"Dennie Gordon","Comedy","px9hV6w6XzAjGdxCRUAUasAHQsP.jpg",11025],["Zelig",1983,4,1,"Woody Allen","Comedy","bfs67JaV4B5xVBvtXd3O4R7nk9G.jpg",11030],["This Is Spinal Tap",1984,3,1,"Rob Reiner","Comedy, Music","kAJ3zmvfcFJ1r8dbsXYQD28RL7K.jpg",11031],["Dressed to Kill",1980,3,1,"Brian De Palma","Thriller, Mystery, Horror","zDGtihDRIF54sJB4bNewwKcpmxv.jpg",11033],["The Notebook",2004,2.5,1,"Nick Cassavetes","Romance, Drama","rNzQyW4f8B8cQeg7Dgj3n6eT5k9.jpg",11036],["The Beverly Hillbillies",1993,0.5,1,"Penelope Spheeris","Comedy, Family","refYLEQvzkY63i2IHronCPQODex.jpg",11041],["The Barbarian Invasions",2003,3,1,"Denys Arcand","Comedy, Drama","ekmFbyMgm3SPklSlDUW1wZ33yMP.jpg",11042],["Interstella 5555: The 5tory of the 5ecret 5tar 5ystem",2003,3,1,"Kazuhisa Takenouchi","Animation, Science Fiction, Music, Adventure","n0K6mjU8aVnag2mi93FuvJsjZi.jpg",11049],["Terms of Endearment",1983,3.5,1,"James L. Brooks","Drama, Comedy","l77DRjJuykqKMtD9GTK4YT7qKHW.jpg",11050],["The Last Temptation of Christ",1988,4.5,1,"Martin Scorsese","Drama","7L4qwrC1mipZXJfU5oRgQWChLv1.jpg",11051],["Hairspray",1988,4,1,"John Waters","Comedy, Music, Romance","n78VVWG1jsEpMCtcye13wy1RiAx.jpg",11054],["Singles",1992,2.5,1,"Cameron Crowe","Romance, Comedy, Drama","4T7OKBdkNBorRKWw7VSeuA225z1.jpg",11068],["Them!",1954,2,1,"Gordon Douglas","Science Fiction, Horror","tP352STF6BvSROi8K3CMM799TVo.jpg",11071],["Blazing Saddles",1974,3.5,1,"Mel Brooks","Western, Comedy","xDSrLJcHJpMXISPdl6sPkS5Xbu6.jpg",11072],["Audition",1999,4.5,1,"Takashi Miike","Horror, Drama","zwGaUMm0wAqi0wkO7LJDlwoA5LP.jpg",11075],["The Majestic",2001,2.5,1,"Frank Darabont","Drama, Romance","m9WrB91B8ghxIZhyFugkoSleBE7.jpg",11086],["The Animal",2001,0.5,1,"Luke Greenfield","Comedy, Science Fiction","oNxEXmKTZtECHs0bQbI6dQoXYMV.jpg",11090],["Hide and Seek",2005,2,1,"John Polson","Horror, Mystery","orY4PX3TNFdCbdVwhKY32UKMvoA.jpg",11096],["Chungking Express",1994,5,3,"Wong Kar-Wai","Drama, Comedy, Romance","43I9DcNoCzpyzK8JCkJYpHqHqGG.jpg",11104],["Vera Drake",2004,3.5,1,"Mike Leigh","Drama","556fElboCLlEmP8UULaYosU45Bc.jpg",11109],["My Fair Lady",1964,2.5,1,"George Cukor","Comedy, Romance, Music","bTXVc29lGSNclf94VIZ49W4gGKl.jpg",11113],["The Princess Diaries 2: Royal Engagement",2004,2,1,"Garry Marshall","Comedy, Drama, Family, Romance","5XToqGcE4qdfOSaCPWI7kAb1bm7.jpg",11130],["Confessions of a Teenage Drama Queen",2004,2.5,1,"Sara Sugarman","Comedy","nQA9Ozh9ftLQyJvuKy6sl5zSlH2.jpg",11132],["The Rescuers Down Under",1990,2.5,1,"Mike Gabriel","Animation, Family, Adventure, Action, Comedy","5koTDBmMAkJOgAe4PL4163UKjvG.jpg",11135],["XXY",2007,3.5,1,"Lucía Puenzo","Drama","4sgoignnXhqjxepHBi2inLFLhSz.jpg",11148],["National Lampoon's Vacation",1983,2,1,"Harold Ramis","Comedy, Adventure","q3DvoqY06yZnRp9faH6uge7n7VP.jpg",11153],["Secrets & Lies",1996,4.5,1,"Mike Leigh","Drama","zQBuRQ3hrLhkEsXcxteUxuxLrvs.jpg",11159],["The Merchant of Venice",2004,3,1,"Michael Radford","Drama, Romance","bvpPg5oTD1qT7hjY3BOsoniYdHG.jpg",11162],["Tora! Tora! Tora!",1970,4,1,"Richard Fleischer","War, History, Drama","c311sN931DixuZRer0JGYCwpx9N.jpg",11165],["Peeping Tom",1960,3,1,"Michael Powell & Emeric Pressburger","Horror, Thriller, Crime","kM4AfLIlbcuRZ621vYjyeBFkuba.jpg",11167],["Spartan",2004,3,1,"David Mamet","Mystery, Action, Drama, Thriller, Crime","rcdhS2g1d38NOoeh0PPAN2bLE7w.jpg",11169],["Mysterious Skin",2004,4,1,"Gregg Araki","Drama","wgSwDqhl6Rt3cuSCwt5sNpPna3x.jpg",11171],["Music and Lyrics",2007,2.5,1,"Marc Lawrence","Comedy, Music, Romance","1WXVpnovC0EETbqcjVhy3hwIITK.jpg",11172],["The Muppet Movie",1979,3,1,"James Frawley","Family, Comedy, Adventure","mfj8yR2vO5BMkaTMu1wvKQLUTsL.jpg",11176],["My Sassy Girl",2001,3,1,"Kwak Jae-yong","Drama, Comedy, Romance","grFSgOnSt8saknfRUY05wLGVJ7T.jpg",11178],["The Return",2003,4,1,"Andrey Zvyagintsev","Drama, Mystery","rCzpDGLbOoPwLjy3OAm5NUPOTrC.jpg",11190],["Wild Hogs",2007,1,1,"Walt Becker","Action, Adventure, Comedy","qYyPCZcpNGZwbyBo1gwdCiW5hHC.jpg",11199],["Patton",1970,3,1,"Franklin J. Schaffner","War, Drama, History","rLM7jIEPTjj4CF7F1IrzzNjLUCu.jpg",11202],["Baby's Day Out",1994,1,1,"Patrick Read Johnson","Comedy, Adventure, Family, Crime","21U2jwl36hoTHsXB3fDuIQkcchu.jpg",11212],["Cinema Paradiso",1988,5,3,"Giuseppe Tornatore","Drama, Romance","gCI2AeMV4IHSewhJkzsur5MEp6R.jpg",11216],["The Trouble with Harry",1955,3,1,"Alfred Hitchcock","Comedy, Mystery","uUXLq7fEG3hI46ZFMZzgHj11S6S.jpg",11219],["Fallen Angels",1995,4.5,3,"Wong Kar-Wai","Action, Romance, Crime","yyM9BPdwttK5LKZSLvHae7QPKo1.jpg",11220],["Cinderella",1950,3,1,"Clyde Geronimi, Wilfred Jackson y Hamilton Luske","Family, Fantasy, Animation, Romance","4nssBcQUBadCTBjrAkX46mVEKts.jpg",11224],["Drunken Master",1978,2.5,1,"Yuen Woo-Ping","Action, Comedy","cf43J2SH8tECZVl9N5n0Q6Ckche.jpg",11230],["The Omega Man",1971,3,1,"Boris Sagal","Science Fiction, Action, Drama, Thriller","qlt65C43HeoDm5K5gYBtT20OeA1.jpg",11234],["The Secret Garden",1993,2.5,1,"Agnieszka Holland","Drama, Family, Fantasy","zf6h5dJ7wVG7LqMO9dhHGHVejzj.jpg",11236],["Psycho (1998)",1998,2,1,"Gus Van Sant","Horror, Mystery, Thriller","",11252],["Hellboy II: The Golden Army",2008,3,1,"Guillermo del Toro","Fantasy, Action","zO0Wdrxnhx3KoJEvychSmnY3urC.jpg",11253],["Meet Dave",2008,1,1,"Brian Robbins","Comedy, Science Fiction, Adventure, Family","3Qfav5aVRcZmq854olMjJ795JJ2.jpg",11260],["Halloween II",1981,2.5,1,"Rick Rosenthal","Horror, Thriller","3nX5HHGgOKaVMxXwMLT9DHO1Ne6.jpg",11281],["Nanny McPhee",2005,2.5,1,"Kirk Jones","Fantasy, Comedy, Family","8tommndfI0W62teXwSmXdmVZ7gz.jpg",11283],["Freddy's Dead: The Final Nightmare",1991,1,1,"Rachel Talalay","Horror, Thriller, Comedy, Fantasy","e4qh58n2WaG4Gyh9VhjOUeN9Mhv.jpg",11284],["A League of Their Own",1992,2.5,1,"Penny Marshall","Comedy, Drama","f9BtX6wYOwJUyfUr4vyeT3COz6m.jpg",11287],["Paper Moon",1973,4.5,1,"Peter Bogdanovich","Comedy, Crime, Drama","3GHG0kTcBWHKdXjj3RdK8GjBCd6.jpg",11293],["Save the Green Planet!",2003,2.5,1,"Jang Joon-hwan","Comedy, Science Fiction, Crime","kou9TDjveVwBhWnxCRUT88RUVCs.jpg",11297],["Cowboy Bebop",1998,4,1,"Shinichiro Watanabe","Action, Animation, Science Fiction","34H5bsNc0EPILVr49TfOYXj50qV.jpg",11299],["Something Wild",1986,3.5,1,"Jonathan Demme","Crime, Comedy, Romance","344lhBozqFWKxBb4fp6azYQMLEy.jpg",11300],["Mystery Train",1989,3.5,1,"Jim Jarmusch","Comedy","f11xq7dBGhz9UDc3dabldAGeXVH.jpg",11305],["The World According to Garp",1982,3.5,1,"George Roy Hill","Drama, Comedy","9ItRFdSCb7Sz3AC9LRxAzbH73kG.jpg",11307],["Koyaanisqatsi",1982,4,1,"Godfrey Reggio","Documentary, Music","6zCNciRcob8lwuydVXgq0esla8L.jpg",11314],["The Rescuers",1977,3.5,1,"Wolfgang Reitherman","Fantasy, Family, Animation, Adventure","9jpDjrRyvv9Nw0piXOpHHQTfxw9.jpg",11319],["Public Enemies",2009,2.5,1,"Michael Mann","Crime, History, Drama","3KgtekisQBrHRsm2cD5UOB6Ce3k.jpg",11322],["Shutter Island",2010,3,1,"Martin Scorsese","Drama, Thriller, Mystery","nrmXQ0zcZUL8jFLrakWc90IR8z9.jpg",11324],["Tommy",1975,3,1,"Ken Russell","Drama, Music","pAImVnqBJwoFAKrcpAe17JjLGUs.jpg",11326],["Midnight Express",1978,3,1,"Alan Parker","Drama, Crime","mIzGfVCSWmmYjLIIbA2BX3rlV56.jpg",11327],["Runaway",2010,4,1,"Kanye West","Drama, Thriller","hpBot7sqaskTdZS264c7hOhGiQ0.jpg",11329],["The Old Man and the Sea",1958,2.5,1,"John Sturges","Adventure, Drama","6Q34dJL6m1vdzAr0jDDKDmNL52e.jpg",11331],["A Bittersweet Life",2005,3.5,1,"Kim Jee-woon","Action, Drama, Crime","czoCxjadYUT2oe9cKzSnU6ZrYoI.jpg",11344],["The Lair of the White Worm",1988,3.5,1,"Ken Russell","Horror, Comedy","bhL5Z8srwSXJuosfBqei9Dxv41C.jpg",11347],["Cape Fear",1962,4,1,"J. Lee Thompson","Thriller, Drama, Crime","xDqaHjMbnebtB05QWgAR8wW86sb.jpg",11349],["The Odd Couple",1968,3.5,1,"Gene Saks","Comedy","d3dKPpzEi7WfgmoMnMwWyQnd2ja.jpg",11356],["Halloween 4: The Return of Michael Myers",1988,2,1,"Dwight H. Little","Horror, Thriller","eFSOkXF9n9hsfGv45MDsPixiOyx.jpg",11357],["Walking Tall",2004,1.5,1,"Kevin Bray","Adventure, Drama, Action, Thriller","2sdmKtRz2SlGSLxxZDePKm5zxus.jpg",11358],["The Indian in the Cupboard",1995,2.5,1,"Frank Oz","Adventure, Family, Fantasy","ozQAmW85tTJu2dhRe3evzyY03Nb.jpg",11359],["Dumbo",1941,4,1,"Ben Sharpsteen","Animation, Family","4x9FmvdJ464Fg7A9XcbYSmxfVw3.jpg",11360],["Halloween 5: The Revenge of Michael Myers",1989,1.5,1,"Dominique Othenin-Girard","Horror, Thriller","rYvP6yMXCIVHnkVtwGaAXFmpzkB.jpg",11361],["Odds and Evens",1978,2.5,1,"Sergio Corbucci","Comedy, Crime, Action","ankqh5ykTnjXiDizWtnbKRu8LPo.jpg",11367],["Blood Simple",1984,4,1,"Joel Coen & Ethan Coen","Crime, Drama, Thriller","svU6pu4lfHn0T5BVZchVxL58HB5.jpg",11368],["The Crying Game",1992,3,1,"Neil Jordan","Crime, Drama, Thriller","ea6HPVTlGa0MmtTrPud0UnP9wh.jpg",11386],["The Natural",1984,2,1,"Barry Levinson","Drama","fwn1gYeOkS1XHKVFdNorKSIpix8.jpg",11393],["The Santa Clause",1994,2.5,1,"John Pasquin","Fantasy, Drama, Comedy, Family","hvV2rI60qOYELT7tHHLpxtafnBZ.jpg",11395],["The New World",2005,3.5,1,"Terrence Malick","Drama, History, Romance","dPyWMlQd54r3pK17GKG3iqjvNZ7.jpg",11400],["Superman IV: The Quest for Peace",1987,1,1,"Sidney J. Furie","Action, Adventure, Science Fiction","nJFBeU1oKIaIoLVyQYUeB36DW55.jpg",11411],["The Mission",1986,4,1,"Roland Joffé","Adventure, Drama, Action, History","6K9cG6LOOtySZF4D4xBu1MApC1N.jpg",11416],["Memories of Murder",2003,5,2,"Bong Joon Ho","Crime, Drama, Thriller","jcgUjx1QcupGzjntTVlnQ15lHqy.jpg",11423],["High Society",1956,2,1,"Charles Walters","Music, Comedy, Romance","eOKLignOrNN7pgTQbwCzW6WPwbD.jpg",11424],["From Here to Eternity",1953,2.5,1,"Fred Zinnemann","War, Romance, Drama","xO1LHnh9aQlQFFq1DxyQrOTia1S.jpg",11426],["The Lion King 1½",2004,2,1,"Bradley Raymond","Adventure, Animation, Comedy, Family","u2hN0WT7Dz46HfhQbr6uzSYfVW4.jpg",11430],["The Ghost Writer",2010,4,1,"Roman Polanski","Thriller, Mystery","rK7m2Ba0ieXa37NaAmrx4dfRvvM.jpg",11439],["Halloween: Resurrection",2002,0.5,1,"Rick Rosenthal","Horror, Thriller","1mlKwbNzJCGzqe4i0ZEJtUUL290.jpg",11442],["Welcome to the Dollhouse",1995,3.5,1,"Todd Solondz","Comedy, Drama","fsMMOVto87pvUQyozOF9CaT9aMR.jpg",11446],["Mighty Aphrodite",1995,3.5,1,"Woody Allen","Comedy, Romance","ice135yQZp4iX2SgCmd90nKgS5j.jpg",11448],["Herbie Fully Loaded",2005,1.5,1,"Angela Robinson","Comedy, Family, Adventure, Fantasy, Romance","7lTfTZ8CDfXw09eAv3OOvsbCVgs.jpg",11451],["Deuce Bigalow: European Gigolo",2005,0.5,1,"Mike Bigelow","Comedy","yXdQ4UGDFCsPrynJOdIk20AYLus.jpg",11453],["Sky High",2005,2.5,1,"Mike Mitchell","Adventure, Comedy, Family","nBB0XNMwvYvWpo67EcxQqKMoMKf.jpg",11459],["Red Eye",2005,2.5,1,"Wes Craven","Thriller, Mystery","osLMnQIjDMmzLvXmOlIOlou9olp.jpg",11460],["Suspicion",1941,3,1,"Alfred Hitchcock","Mystery, Romance, Thriller","clWNlzlbyaEoIK63lcFjqBmXoQz.jpg",11462],["The Warriors",1979,3.5,1,"Walter Hill","Action, Thriller","sjN9IZHmRHZmpxvQYYYFNQ22Pch.jpg",11474],["Leningrad Cowboys Go America",1989,3.5,1,"Aki Kaurismäki","Comedy, Music","rYI5IAKwqOl6nPcAYL58VzI0EXN.jpg",11475],["Repulsion",1965,4,1,"Roman Polanski","Drama, Thriller, Horror","dtyCKEPLqv9wxyVazL4b843vtUb.jpg",11481],["The Tenant",1976,4,1,"Roman Polanski","Thriller, Mystery, Drama","4Qhzb1ICFMqE3isWoln497qSH7n.jpg",11482],["Take the Money and Run",1969,3.5,1,"Woody Allen","Comedy, Crime","dT7cKFxsuHzSnDBxKeP5acoIpWZ.jpg",11485],["Rosetta",1999,3,1,"Jean-Pierre Dardenne & Luc Dardenne","Drama","buwLjQPPA9FaATvKzeAppLXiGMB.jpg",11489],["The Child",2005,3.5,1,"Jean-Pierre Dardenne & Luc Dardenne","Drama","dk7ZpsVKLt2nwjQZZIde0WP4oQV.jpg",11490],["All Dogs Go to Heaven",1989,3,1,"Don Bluth","Drama, Animation, Family, Comedy, Fantasy","nmWh1NglDinfkHD9zCNqGWyhl7Q.jpg",11497],["Knife in the Water",1962,3,1,"Roman Polanski","Drama, Thriller","tkdeCwZhy9hzzVjZFjw0RPGWUIg.jpg",11502],["The Silence",1963,4.5,1,"Ingmar Bergman","Drama, Romance","2KkHAsBVZVoMO1Zauvm5rFSxp09.jpg",11506],["1941",1979,1.5,1,"Steven Spielberg","Comedy, War, Action","52Bn5yC6IHQuVxPUza3Q6RZCZTu.jpg",11519],["View from the Top",2003,1.5,1,"Bruno Barreto","Comedy, Romance, Drama","q8oHvYoFICQpTWjC15ZMwQr5Sox.jpg",11523],["The Sandlot",1993,3.5,1,"David Mickey Evans","Family, Comedy, Drama","7PYqz0viEuW8qTvuGinUMjDWMnj.jpg",11528],["The Misfits",1961,4,1,"John Huston","Drama, Romance, Western","rkIkyPhT5oetT463HxpdIuct30l.jpg",11536],["Altered States",1980,4,1,"Ken Russell","Horror, Science Fiction, Thriller","fsoaPN5SWYgZ4B7GG9nRNj33so.jpg",11542],["Lilo & Stitch",2002,4,3,"Chris Sanders & Dean DeBlois","Animation, Family, Comedy, Science Fiction","d73UqZWyw3MUMpeaFcENgLZ2kWS.jpg",11544],["Rushmore",1998,5,3,"Wes Anderson","Comedy, Drama","hSJ6swahAuZ8wM96lHDTwQPXUvZ.jpg",11545],["Invasion of the Body Snatchers",1956,4,1,"Don Siegel","Science Fiction, Horror, Thriller","8BrMQmgwGzIHSyBjCDOLOdi79fJ.jpg",11549],["Small Soldiers",1998,2.5,1,"Joe Dante","Comedy, Adventure, Fantasy, Science Fiction, Action","2nuUjSzHsoYlRvTPmLo7m7gCQry.jpg",11551],["Tideland",2005,2,1,"Terry Gilliam","Fantasy, Drama, Thriller","mjCRfmxg7awp5kVIM1lHR0d7S4A.jpg",11559],["Sleeper",1973,2.5,1,"Woody Allen","Comedy, Science Fiction","YTYSziZZP5aXt5CDvdEMwKDzme.jpg",11561],["Crimes and Misdemeanors",1989,5,1,"Woody Allen","Comedy, Drama, Crime","6vC6MLYUICH57MmEVi1UaNaj2Qs.jpg",11562],["Big Momma's House 2",2006,1.5,1,"John Whitesell","Comedy, Crime","wlbov6pkgySqYZilZcO54f29Dg1.jpg",11565],["Pat Garrett & Billy the Kid",1973,3.5,1,"Sam Peckinpah","Western, Drama, History","o0LXWfTXoDOoeYzZw0u1KmZhVIL.jpg",11577],["Roxanne",1987,3,1,"Fred Schepisi","Comedy, Romance","c2XSGkpAIIof6Oi8Sr6wBvwt1Lk.jpg",11584],["Exorcist II: The Heretic",1977,2,1,"John Boorman","Horror","g9i3LTMYLRHvCYSKimZEfd1Vqy7.jpg",11586],["The Exorcist III",1990,4,1,"William Peter Blatty","Horror, Drama","bl6nSPcyqz6xD2Igd2VQvz8qWo0.jpg",11587],["Slap Shot",1977,3,1,"George Roy Hill","Comedy, Drama","k5dvEA7ajd90mf3KrF6m6LnYXOv.jpg",11590],["Serial Mom",1994,4,1,"John Waters","Comedy, Crime","vAZkFho9YdIXPmMdHMwr10Go2FF.jpg",11592],["Wes Craven's New Nightmare",1994,4,1,"Wes Craven","Horror, Mystery, Fantasy","eN3UZUYapJ2CJCD9dN0LUZLouKa.jpg",11596],["Through a Glass Darkly",1961,4.5,1,"Ingmar Bergman","Drama","rYD30Fm4vAcBqk1kTsxHw1s8P29.jpg",11602],["Go for It",1983,2,1,"Enzo Barboni","Adventure, Action, Comedy","gfv6ctg1BTtpQeOkwThe4EzDSK9.jpg",11616],["Flushed Away",2006,3,1,"David Bowers","Adventure, Animation, Comedy, Family","kgoZI4xh38RrEYEPVib6a12UPLn.jpg",11619],["Porco Rosso",1992,3.5,2,"Hayao Miyazaki","Animation, Adventure, Fantasy","8mIvSvnVBApfORL9N6S38Q7wD6A.jpg",11621],["Blast from the Past",1999,3.5,1,"Hugh Wilson","Drama, Romance, Comedy","qVN4bbVX2tzaNbAdEJT5eOPq26c.jpg",11622],["Everything You Always Wanted to Know About Sex *But Were Afraid to Ask",1972,2.5,1,"Woody Allen","Comedy","A1ZNhNd8FV8kCW39OeDelokT0tv.jpg",11624],["Mamma Mia!",2008,2.5,1,"Phyllida Lloyd","Comedy, Romance","zdUA4FNHbXPadzVOJiU0Rgn6cHR.jpg",11631],["Old School",2003,2,1,"Todd Phillips","Comedy","nYtuwNHpEoIbTgS3aFPSEwZNN6l.jpg",11635],["Are We There Yet?",2005,1,1,"Brian Levant","Family, Adventure, Comedy, Romance","guDkMD4wrZ1BGUO7DFFBVzaiGij.jpg",11637],["The Dark Crystal",1982,3,1,"Frank Oz","Adventure, Family, Fantasy","6g1Kh73qQRosyhRJpL3euQpMxOE.jpg",11639],["Blow Out",1981,4.5,1,"Brian De Palma","Crime, Mystery, Thriller","nzYNrav10oXRKDy183PeDG3XoeT.jpg",11644],["Ran",1985,5,2,"Akira Kurosawa","Action, Drama, History","jQnUtWaHYfqnXPOIf77K7Ycqk4M.jpg",11645],["The Hunger",1983,3.5,1,"Tony Scott","Horror, Drama","lFTDtRtK8J55A1LTpwigV7QGQg7.jpg",11654],["Cronos",1992,3.5,1,"Guillermo del Toro","Drama, Horror, Thriller","bRX8au50CnhC8hXr8AbsCNdb96G.jpg",11655],["The Virgin Spring",1960,4.5,1,"Ingmar Bergman","Drama, History","z70YM3Y4pNYZATMhFMKonngaeMC.jpg",11656],["Following",1998,3,2,"Christopher Nolan","Drama, Thriller","3bX6VVSMf0dvzk5pMT4ALG5A92d.jpg",11660],["The Commitments",1991,3.5,1,"Alan Parker","Comedy, Drama, Music","iccBDq9aS1gwi6b8aJjBgPU4t2D.jpg",11663],["Get Smart",2008,2,1,"Peter Segal","Action, Comedy, Thriller","sZUjbtUS8qxXp4mj90evnqPJqX7.jpg",11665],["101 Dalmatians",1996,2.5,1,"Stephen Herek","Family, Comedy","8o2ADoAyG796UwTjwBFjPyBz0yG.jpg",11674],["Halloween H20: 20 Years Later",1998,2.5,1,"Steve Miner","Horror, Thriller","lqLXUm3oK59sGJKRH2Zjj2m3iMg.jpg",11675],["Vertical Limit",2000,2.5,1,"Martin Campbell","Adventure, Action, Thriller","kpqQUEi8eAyYHMDFACf6YlnPIu7.jpg",11678],["xXx: State of the Union",2005,1.5,1,"Lee Tamahori","Action, Adventure, Crime, Thriller","nL9J0N3HJSdZTKRsd5xcE6IzL5s.jpg",11679],["Love and Death",1975,3,1,"Woody Allen","Comedy, History","oJXFd1UHZoOQ1UtoLxbyBLGJDox.jpg",11686],["The Emperor's New Groove",2000,3,1,"Mark Dindal","Adventure, Animation, Comedy, Family, Fantasy","isA0acj3ONKBLp1pKadUNzxEPFv.jpg",11688],["The Man Who Shot Liberty Valance",1962,4,1,"John Ford","Western","4C1R0LEivLjbv3swAzJfzh0tzXl.jpg",11697],["Smiles of a Summer Night",1955,3,1,"Ingmar Bergman","Comedy, Romance","wKeV8lKz8k9DDBCw6MJ9MkhvhqF.jpg",11700],["Red Road",2006,3,1,"Andrea Arnold","Drama, Thriller","cxS2bylNtyGevLcFHowIHvGkQGv.jpg",11705],["Sanjuro",1962,4,1,"Akira Kurosawa","Drama, Action, Comedy","zW47oIH3bc3ggmmmzTvKqM4Fqjk.jpg",11712],["Shaolin Soccer",2001,3.5,1,"Stephen Chow","Action, Comedy","z6ZQqwoxWy9muIxwUP4K2zWw7BU.jpg",11770],["The Haunting",1963,3.5,1,"Robert Wise","Horror","fmpTnUKTcrpuxLSY23gQMUf9qu7.jpg",11772],["Village of the Damned",1960,3.5,1,"Wolf Rilla","Horror, Science Fiction","qcpXud1UjQzlSe9A062w8Wqgira.jpg",11773],["Lemony Snicket's A Series of Unfortunate Events",2004,3.5,1,"Brad Silberling","Adventure, Comedy, Family","76Xi8z7Whv5WFIdfzzvC5tKSicd.jpg",11774],["Intolerable Cruelty",2003,2.5,1,"Joel Coen & Ethan Coen","Comedy, Romance, Crime","7K8hDwOWsZv0MluyrB8nWlhJOgB.jpg",11775],["The Deer Hunter",1978,4.5,1,"Michael Cimino","Drama, War","bbGtogDZOg09bm42KIpCXUXICkh.jpg",11778],["Buena Vista Social Club",1999,3.5,1,"Wim Wenders","Documentary, Music","b203Z3qwCRMLOY00XZh4qNQCwM4.jpg",11779],["Hard Boiled",1992,4,1,"John Woo","Action, Thriller, Crime","mbA77wY7fjh2TSQ3FxEuqpKOOA8.jpg",11782],["Fright Night",1985,3.5,1,"Tom Holland","Comedy, Horror","euIh75MwNDrYkTEVSkw7VXWGXoE.jpg",11797],["This Is England",2006,3.5,1,"Shane Meadows","Drama, Crime","6ZVx7wLrlgSKxkYC2CRg6Zek0fG.jpg",11798],["The Fly (1958)",1958,3,1,"Kurt Neumann","Science Fiction, Horror, Drama","e6LwGoLCLVPYljPgZRtsFYuEVe7.jpg",11815],["On Golden Pond",1981,3,1,"Mark Rydell","Drama, Romance","ic4f03J6pnf9cpQmVDABFhUpbCU.jpg",11816],["Mona Lisa Smile",2003,2.5,1,"Mike Newell","Drama, History, Romance","bg0VKsXnLjIZ0cHmZHZLs9gzrvm.jpg",11820],["Sexy Beast",2000,4,1,"Jonathan Glazer","Crime, Thriller, Drama","6P7hx0JR9m38P01ToCPCx13wYHJ.jpg",11826],["Tampopo",1985,4.5,2,"Jūzō Itami","Comedy","ArYdSuX3zY9fMsE4LqmBl7xJq5R.jpg",11830],["Amistad",1997,2,1,"Steven Spielberg","Drama, History, Mystery","6QqNyIHKow0jngiQgTNBOBrLILM.jpg",11831],["Jabberwocky",1977,2.5,1,"Terry Gilliam","Fantasy, Comedy","kprcqmFxWPU45L1ZnMXO5yPPMVA.jpg",11834],["The SpongeBob SquarePants Movie",2004,3.5,2,"Stephen Hillenburg","Adventure, Animation, Comedy, Family, Fantasy","1rvzKV1d18EbDVaEd4VDzK3cgnY.jpg",11836],["Ju-on: The Grudge",2002,3,1,"Takashi Shimizu","Horror","6q1hlBC6rudc3mHwXsbMBR2xAT6.jpg",11838],["Dungeons & Dragons",2000,0.5,1,"Courtney Solomon","Drama, Adventure, Fantasy","tLCsyHLHhTbzKzsL3IcBNyDKlZm.jpg",11849],["Invasion of the Body Snatchers (1978)",1978,4,1,"Philip Kaufman","Science Fiction, Horror","skS02wdeH2C0nrbCQP3qKwJdZtZ.jpg",11850],["The Hot Chick",2002,1,1,"Tom Brady","Comedy, Fantasy","lnnGE4TKa05t20SZ2batuAhXCp4.jpg",11852],["Dracula (1958)",1958,2.5,1,"Terence Fisher","Horror","9UHOATvzXQWbElSGygOY1ar3vpp.jpg",11868],["Big Fat Liar",2002,1.5,1,"Shawn Levy","Family, Comedy, Adventure","3EjpQeyOpH8VIaWqIq6SpCQrCks.jpg",11870],["The Color of Money",1986,3.5,1,"Martin Scorsese","Drama","dVdnHmdQu3JtLAAksjTmTEF76gD.jpg",11873],["Yojimbo",1961,4,1,"Akira Kurosawa","Drama, Thriller","tN7kYPjRhDolpui9sc9Eq9n5b2O.jpg",11878],["Near Dark",1987,3,1,"Kathryn Bigelow","Horror","hVhFNn3IQxxARvnpLIKMx8ZfTtG.jpg",11879],["Miracle on 34th Street",1947,3,1,"George Seaton","Comedy, Drama, Family","vehuIm3y6BeMI7mYjxzaA1H8M0k.jpg",11881],["Robin Hood",1973,3.5,1,"Wolfgang Reitherman","Animation, Family, Adventure","x9AvkYek0bGdxQSZ8W3lAjGrREm.jpg",11886],["High School Musical 3: Senior Year",2008,1.5,1,"Kenny Ortega","Comedy, Drama, Family","aq2o1wT0crBOTxof36O6KTyjpgE.jpg",11887],["Snow Dogs",2002,1,1,"Brian Levant","Comedy, Family, Adventure","8DDC6z1XyLSiNLzKw1pXcYeAOJ3.jpg",11888],["Kung Pow: Enter the Fist",2002,2,1,"Steve Oedekerk","Comedy, Action, Adventure","gVsZ1hsJ9g11oCCav4N8ccp9bRw.jpg",11891],["Kind Hearts and Coronets",1949,3,1,"Robert Hamer","Comedy, Crime","eBvpyRjD3DcCsWgdV6Y9oqPS7dO.jpg",11898],["Underground",1995,4,1,"Emir Kusturica","Comedy, Drama, War","h8N6y13t4VusrDdH5PzTkwvBvgN.jpg",11902],["Suspiria",1977,3,1,"Dario Argento","Horror","sEcvc9h1X3hYZdFgtiiKMm6RB3f.jpg",11906],["Saw V",2008,1,1,"David Hackl","Horror, Thriller, Crime","rKl79KqLXg60KFyKsLe4wSSjQ08.jpg",11917],["Superhero Movie",2008,1,1,"Craig Mazin","Comedy, Action, Science Fiction","nAzo5OOmoE9SXOv4mHTuiu58QXA.jpg",11918],["Tetro",2009,2.5,1,"Francis Ford Coppola","Drama","t2FKTAf9aQoRgU0Z5KTJJwBfDCF.jpg",11928],["The Hudsucker Proxy",1994,3.5,1,"Joel Coen & Ethan Coen","Comedy, Drama, Fantasy","bp5Kg9iT9oSXsECgDkNJVqvIrxX.jpg",11934],["Kagemusha",1980,3.5,1,"Akira Kurosawa","Action, Drama, History, War","fJgqj9s8HNZz9zwX6femVJn8HEB.jpg",11953],["Tombstone",1993,4,1,"George P. Cosmatos","Western, Action","wGFCvylul8iEQhJOKfwZGGvXMzA.jpg",11969],["Hercules",1997,3,1,"John Musker & Ron Clements","Animation, Family, Fantasy, Adventure, Comedy, Romance","dK9rNoC97tgX3xXg5zdxFisdfcp.jpg",11970],["Much Ado About Nothing",1993,1.5,1,"Kenneth Branagh","Drama, Comedy, Romance","tvltGP6vYOkHdURag0jPSjhPUAV.jpg",11971],["The 'Burbs",1989,3,1,"Joe Dante","Comedy, Horror, Thriller","jwYKzJS0C3A711hmg1G4ptI0InF.jpg",11974],["The Rainmaker",1997,2.5,1,"Francis Ford Coppola","Drama, Crime, Thriller","twLGHXPjQtS8UyVGp5GXmhJiTM7.jpg",11975],["Legend",1985,2.5,1,"Ridley Scott","Adventure, Fantasy","6n3PQSYpZRK5YPk2w8JEwED7AZk.jpg",11976],["Caddyshack",1980,1.5,1,"Harold Ramis","Comedy","lXnNz7zOXCsftMDVoU3VSo0Eioi.jpg",11977],["Men of Honor",2000,2,1,"George Tillman Jr.","Drama","wNUAnXV1mzOOfvnVBIYsalkk078.jpg",11978],["Look Who's Talking Now!",1993,2,1,"Tom Ropelewski","Romance, Comedy, Family","73JahFiizkMVsrrslXInmNK54nC.jpg",11982],["Machuca",2004,4,2,"Andrés Wood","Drama","sP3ceWIvq7DZm8VLYWuFKzbDK43.jpg",12086],["Just Married",2003,1,1,"Shawn Levy","Romance, Comedy","FRqnYDjbstsCgLSJJ3SifOh2ca.jpg",12090],["Alice in Wonderland",1951,3.5,1,"Clyde Geronimi, Wilfred Jackson y Hamilton Luske","Animation, Family, Fantasy, Adventure","20cvfwfaFqNbe9Fc3VEHJuPRxmn.jpg",12092],["Lilya 4-ever",2002,4,1,"Lukas Moodysson","Drama, Crime","5i1uhvcdv2Iogx0Bb1znvUmkCvN.jpg",12093],["The Pink Panther (2006)",2006,2,1,"Shawn Levy","Comedy, Mystery, Crime, Adventure, Family","th6i4TqJa5tEQaSKul2XgqSqTV9.jpg",12096],["Soylent Green",1973,2.5,1,"Richard Fleischer","Science Fiction, Crime, Mystery","5nbkShkOEXUoKVhaX0XG41wyBkq.jpg",12101],["Kramer vs. Kramer",1979,3.5,1,"Robert Benton","Drama","3CUP5V5SWfHSK4qvkZF7lMNyugY.jpg",12102],["Pink Floyd: The Wall",1982,4,2,"Alan Parker","Music, Drama","aElHyIdF5jmctFGhlhhaPFsbBJC.jpg",12104],["Yellow Submarine",1968,3.5,1,"George Dunning","Music, Animation, Adventure, Comedy, Fantasy","1pmeLKaLFNggcsAk5FiouIvo3ST.jpg",12105],["The Quick and the Dead",1995,3,1,"Sam Raimi","Western, Action, Drama, Thriller","jhEmrXJpP6F3cqwyLjvgBgxxxFA.jpg",12106],["Nutty Professor II: The Klumps",2000,1.5,1,"Peter Segal","Comedy, Science Fiction","v8gI95Eio7kAjixyqYHxNKmJTmm.jpg",12107],["Body of Lies",2008,2,1,"Ridley Scott","Action, Drama, Thriller","sLjVDPPfNQfAma9XyOqHPClQb2V.jpg",12113],["Village of the Damned (1995)",1995,3,1,"John Carpenter","Thriller, Horror, Science Fiction","pXXNmSVqkvSMoMitsdjK0V8Dkna.jpg",12122],["Step Brothers",2008,2.5,1,"Adam McKay","Comedy","nvggBbEraUTAVR6ffP3AaBUWSHs.jpg",12133],["Dennis the Menace",1993,1,1,"Nick Castle","Family, Comedy","t642WwGifbQ2fEuKTJRgpPzsgtX.jpg",12139],["The Land Before Time",1988,3,1,"Don Bluth","Family, Animation, Adventure","7phV1ETZnQrLsEeuk4hNeceEl25.jpg",12144],["Sea of Love",1989,2.5,1,"Harold Becker","Crime, Drama, Romance","vJ88WmJ12eAK9CRb3cggn9CJthH.jpg",12150],["White Chicks",2004,1,1,"Keenen Ivory Wayans","Comedy, Crime","aHTUpo45qy9QYIOnVITGGqLoVcA.jpg",12153],["3 Men and a Baby",1987,2,1,"Leonard Nimoy","Comedy","oYetboAljWR2N5A7MU3i63DvUtd.jpg",12154],["Alice in Wonderland (2010)",2010,2.5,1,"Tim Burton","Family, Fantasy, Adventure","o0kre9wRCZz3jjSjaru7QU0UtFz.jpg",12155],["What Dreams May Come",1998,3,1,"Vincent Ward","Drama, Fantasy, Romance","78wCdphUzeb528wLZw2W0fn7yGB.jpg",12159],["The Hurt Locker",2008,3.5,1,"Kathryn Bigelow","Drama, Thriller, War","io2dfBJhasvGbgkCX9cCGVOiA99.jpg",12162],["The Wrestler",2008,4,1,"Darren Aronofsky","Drama, Romance","6OTR8dSoNGjWohJNo3UhIGd3Tj.jpg",12163],["Encounters at the End of the World",2007,4,1,"Werner Herzog","Documentary","tAkl9GAUQoJaQQu2dtSQdQJ5yS9.jpg",12172],["Star Wars: The Clone Wars",2008,1.5,1,"Dave Filoni","Animation, Action, Science Fiction, Adventure","iJQfixW818LUdSXlCDL3JZm0S0g.jpg",12180],["Defending Your Life",1991,2.5,1,"Albert Brooks","Romance, Fantasy, Comedy, Drama","flXJ4AnKYq8DH1f1TmQ4QrqSwsB.jpg",12186],["Four Christmases",2008,1,1,"Seth Gordon","Comedy, Romance, Drama","zixj44TC7rwzpxtJAG5OzFJnEqe.jpg",12193],["Horton Hears a Who!",2008,2.5,1,"Steve Martino","Animation, Comedy, Family, Adventure, Fantasy","6k47Z3A5zI2rxubTMwiLyIqQLLr.jpg",12222],["One Hundred and One Dalmatians",1961,4,2,"Wolfgang Reitherman","Adventure, Animation, Comedy, Family","kSlYq6FrBUviGSEh8v4L9nrSnBT.jpg",12230],["Oliver & Company",1988,2.5,1,"George Scribner","Animation, Comedy, Family","dgaSqUHjm4CLOdiiJJJstVdreEe.jpg",12233],["Mulan II",2004,1.5,1,"Darrell Rooney","Animation, Comedy, Family, Action","mIHE3BKyAKG8ocRAoZuCQN1NTv9.jpg",12242],["Shotgun Stories",2007,3,1,"Jeff Nichols","Drama, Thriller","aeIlHt28Z8KmHcKEgl4oLHpwZ8M.jpg",12247],["Spy Kids 3-D: Game Over",2003,2,1,"Robert Rodriguez","Family, Action, Comedy, Adventure, Science Fiction","buA8dN4zLNr0dYBeKfHfMnEfdLE.jpg",12279],["Slumdog Millionaire",2008,4,1,"Danny Boyle","Drama, Romance","5leCCi7ZF0CawAfM5Qo2ECKPprc.jpg",12405],["Stone of Destiny",2008,2,1,"Charles Martin Smith","Drama, Crime, Comedy","rZWhnQY4Efi0iYQpnagP4vyaYps.jpg",12407],["Ponyo",2008,3,1,"Hayao Miyazaki","Animation, Fantasy, Family","yp8vEZflGynlEylxEesbYasc06i.jpg",12429],["Harry Potter and the Deathly Hallows: Part 2",2011,2.5,1,"David Yates","Adventure, Fantasy","iGoXIpQb7Pot00EEdwpwPajheZ5.jpg",12444],["Harry Potter and the Deathly Hallows: Part 1",2010,2.5,1,"David Yates","Adventure, Fantasy","iGoXIpQb7Pot00EEdwpwPajheZ5.jpg",12444],["The Five Obstructions",2003,3.5,1,"Lars von Trier","Documentary","xMcCmIdos88yd44xqCXj4NUWph3.jpg",12456],["Grave of the Fireflies",1988,4.5,1,"Isao Takahata","Animation, Drama, War","k9tv1rXZbOhH7eiCk378x61kNQ1.jpg",12477],["High and Low",1963,5,1,"Akira Kurosawa","Drama, Crime, Thriller","tgNjemQPG96uIezpiUiXFcer5ga.jpg",12493],["Dreams (1990)",1990,3.5,1,"Akira Kurosawa","Fantasy, Drama","ua17wrOrUjyqxuYmnUrmOVBMf4G.jpg",12516],["Strawberry and Chocolate",1993,3,1,"Tomás Gutiérrez Alea","Comedy, Drama","tMwUsu080E4kS4rkHPffy1ugvaJ.jpg",12527],["High Anxiety",1977,2.5,1,"Mel Brooks","Comedy, Mystery, Thriller","hCazLbbAveK7Ohc2xT3b3GioNjR.jpg",12535],["Home Alone 4",2002,1,1,"Rod Daniel","Comedy, Family, TV Movie","qRktvMOO2QaCL7gvNyvZDoxPOZj.jpg",12536],["Jesus Christ Superstar",1973,4,2,"Norman Jewison","Drama, History","2NQgIjHxYyMJZWeUFH5cuKhN4nh.jpg",12545],["I Vitelloni",1953,3,1,"Federico Fellini","Comedy, Drama","boqcM6bhQICnNue4pkgmauj9JN3.jpg",12548],["Ghosts of Girlfriends Past",2009,1.5,1,"Mark Waters","Romance, Comedy, Fantasy","azzg0lv5vpQRoOrZfNVkJn04f1M.jpg",12556],["A Serious Man",2009,4.5,1,"Joel Coen & Ethan Coen","Comedy, Drama","5gGxDS8WmrebPlMHexVS8EVehiP.jpg",12573],["Jimmy Neutron: Boy Genius",2001,2,1,"John A. Davis","Family, Comedy, Adventure, Animation, Science Fiction","pUwdquA6Bf3Gq8yT5iQL1Yq0jkl.jpg",12589],["Fritz the Cat",1972,3.5,1,"Ralph Bakshi","Animation, Comedy, Drama","llgCW1Y99WO7DNiX3ZOncLJBIAm.jpg",12593],["Pokémon 4Ever",2001,1.5,1,"Kunihiko Yuyama","Adventure, Fantasy, Animation, Science Fiction, Family","thz83PS9twtVBEEAM59J1bh75nU.jpg",12600],["Help! I'm a Fish",2000,2.5,1,"Michael Hegner","Adventure, Animation, Comedy, Family, Drama","s9yFQD19xJqXEnAnUAZFUan25DJ.jpg",12609],["Osmosis Jones",2001,2,1,"Peter Farrelly & Bobby Farrelly","Action, Adventure, Animation, Comedy, Family, Science Fiction","foZpSG88IQUCEBJE3unc5QzO6bQ.jpg",12610],["The House Bunny",2008,2,1,"Fred Wolf","Romance, Comedy","4oGGJ824vqIqDtyMvMuK44pDEmx.jpg",12620],["Broadcast News",1987,4.5,1,"James L. Brooks","Comedy, Romance","cEsKWkJRr9lHGV4rJui7Z6TV8VE.jpg",12626],["New York, New York",1977,3,1,"Martin Scorsese","Romance, Drama, Music","1nD40aUcPAxYdE1WxERrTjZuFGe.jpg",12637],["Psycho III",1986,2.5,1,"Anthony Perkins","Horror, Mystery, Thriller","tgV4eeW0X7os7p3SYbNwDI0NYGa.jpg",12662],["Sabotage",1936,3.5,1,"Alfred Hitchcock","Drama, Thriller, Crime","A6cyOt9mhmvWA2uHcVsGkcCaHCz.jpg",12684],["The Fog of War",2003,4,1,"Errol Morris","Documentary, TV Movie","m1dEnkrdJGBSLeAyJepuGrU9sNI.jpg",12698],["Ishtar",1987,2.5,1,"Elaine May","Comedy, Adventure","2n6cDGd84I1KvCeYlTju7MBC9sN.jpg",12704],["Suicide Club",2001,2,1,"Sion Sono","Drama, Horror, Thriller","oMjWlKHzR9cwhf3oCUy9j57o67O.jpg",12720],["Autumn Sonata",1978,5,1,"Ingmar Bergman","Drama, Music","6beNbtCXv3GkzHkxkGYf38ib7v8.jpg",12761],["Broadway Danny Rose",1984,3.5,1,"Woody Allen","Comedy","oUgolImcg0PRiT33UNjK409aQoJ.jpg",12762],["Futurama: The Beast with a Billion Backs",2008,3.5,1,"Peter Avanzino","Animation, Comedy, Science Fiction, Romance","2BW6JAW4wo7t5wD3WVfoijzosvt.jpg",12889],["El Topo",1970,2.5,1,"Alejandro Jodorowsky","Adventure, Drama, Western","fKoNBTATc94rUYLq8VyypS24LUw.jpg",13041],["Bolt",2008,3,1,"Chris Williams","Animation, Family, Adventure, Comedy","v5aC4nrzXFGJDWY4JO1eengXzqk.jpg",13053],["Your Friend the Rat",2007,3,1,"Jim Capobianco","Animation, Family, Comedy, Documentary","zdZWEPeIGSdXZ0fOshcZY8LkysU.jpg",13061],["All the Real Girls",2003,3.5,1,"David Gordon Green","Drama, Romance","sQ6dMkwPIFucYSmFQcr38WBYzs.jpg",13132],["Scooby-Doo on Zombie Island",1998,2,1,"Jim Stenstrum","Animation, Mystery, Family, Horror","7xliOcDY0vN6kiqHGVzgPMsBX2c.jpg",13151],["Freddy Got Fingered",2001,1,1,"Tom Green","Comedy","gVmSZgxiT7ynyRLsEgg8Xs8ZVWX.jpg",13166],["Smiley Face",2007,4,1,"Gregg Araki","Comedy","kGQZGujjw8S6NKs5C8nugsMtol.jpg",13168],["Tinker Bell",2008,2,1,"Bradley Raymond","Animation, Family, Adventure, Fantasy","3Ma0r1n8kfH7UaQMS7bJ9KsYUjT.jpg",13179],["Watchmen",2009,3.5,1,"Zack Snyder","Mystery, Action, Science Fiction","aVURelN3pM56lFM7Dgfs5TixcIf.jpg",13183],["A Charlie Brown Christmas",1965,4,1,"Bill Melendez","Animation, Family, Comedy, TV Movie","n2h4lBtZnYuRwSagKoFTSzVO9jp.jpg",13187],["Gran Torino",2008,4,1,"Clint Eastwood","Drama","zUybYvxWdAJy5hhYovsXtHSWI1l.jpg",13223],["Bah, Humduck!: A Looney Tunes Christmas",2006,1.5,1,"Charles Visser","Animation, Comedy, Family","f568JOtSlQoevRIDBKK3YIkHbvd.jpg",13248],["Futurama: Bender's Game",2008,2.5,1,"Dwayne Carey-Hill","Animation, Comedy, Science Fiction, Action, Fantasy, Adventure","bx8OVOBn5WP9TJJuOpRzyMCdzzb.jpg",13253],["Let the Right One In",2008,4.5,1,"Tomas Alfredson","Horror, Drama","7IG4WjaAOVDlLvLUkh513HSwhW8.jpg",13310],["Funny Face",1957,3.5,1,"Stanley Donen","Music, Comedy, Romance","tzTjalpIz6NyFrWPPlOBFoBjb7z.jpg",13320],["Harold & Kumar Escape from Guantanamo Bay",2008,2,1,"Hayden Schlossberg","Comedy, Adventure","gmXKlm8c8O7JEISYP4WiWq2x3We.jpg",13335],["Fast Times at Ridgemont High",1982,2,1,"Amy Heckerling","Comedy, Romance, Drama","s1DA8H7qwoOcAEhow2rCzuQtpuO.jpg",13342],["It's the Great Pumpkin, Charlie Brown",1966,3.5,1,"Bill Melendez","Family, Animation, TV Movie, Comedy","59wp9OWexYsxlSPHYmVLsl5xlFt.jpg",13353],["The Man from Earth",2007,3.5,1,"Richard Schenkman","Science Fiction, Drama","V086R82gNgWrotaXZFO4JhdgB1.jpg",13363],["White Christmas",1954,2,1,"Michael Curtiz","Comedy, Music, Romance","A5kBQsHKbIptxJyELEpHQJROCRj.jpg",13368],["A Mighty Wind",2003,3,1,"Christopher Guest","Comedy, Music","5wUYwAD75BxtJ0Mp4da6XzHIFex.jpg",13370],["Ice Princess",2005,2,1,"Tim Fywell","Family, Drama, Comedy","oLWeyvu0ZJrpxDsRrzsMeaGzyZp.jpg",13374],["How the Grinch Stole Christmas!",1966,3.5,1,"Chuck Jones","Animation, Family, Comedy","7ir0iRuPK9OEuH569cp0nF5CJce.jpg",13377],["Kes",1969,4.5,1,"Ken Loach","Drama","r1FMq75irhsQBVGjXhPU4xA9SDo.jpg",13384],["Righteous Kill",2008,1,1,"Jon Avnet","Crime, Thriller, Mystery, Drama","wKL5pzUfGOqOFjf0VN47nXlZOAL.jpg",13389],["My Father and My Son",2005,2.5,1,"Çağan Irmak","Drama","ephCcqJYZFUnkQC7Oudah2qUL6O.jpg",13393],["Shrek the Halls",2007,2,1,"Gary Trousdale & Kirk Wise","Adventure, Animation, Comedy, Fantasy, Family","zeqUbXA0JPSlyAHdRTgxoYgK24n.jpg",13394],["Tokyo Godfathers",2003,3,1,"Satoshi Kon","Animation, Drama, Comedy","sPC66btzQlzuRdPKiSDYZ5Hvxgc.jpg",13398],["Robbie the Reindeer: Hooves of Fire",1999,2.5,1,"Richard Starzak","Animation, Comedy, Family, TV Movie","r0xVWX3pNNscD9YMn0qXBMl11wl.jpg",13399],["Hedwig and the Angry Inch",2001,4,1,"John Cameron Mitchell","Comedy, Music, Drama","jafIFAW8sHQkzWPGoMDR4892dFI.jpg",13403],["Kronk's New Groove",2005,2,1,"Saul Blinkoff","Animation, Comedy, Family","kyMrt0RPVC8LDpdMrk1DjN6Gqdu.jpg",13417],["Angels & Demons",2009,1.5,1,"Ron Howard","Thriller, Mystery","tFZQAuulEOtFTp0gHbVdEXwGrYe.jpg",13448],["The Adventures of Ichabod and Mr. Toad",1949,3,1,"Clyde Geronimi, Wilfred Jackson y Hamilton Luske","Horror, Fantasy, Animation, Family","n6w1zhFfuMcvCNS1QzvcJ6XAv99.jpg",13465],["Star Trek",2009,2.5,1,"J.J. Abrams","Science Fiction, Action, Adventure","9vaRPXj44Q2meHgt3VVfQufiHOJ.jpg",13475],["A Charlie Brown Thanksgiving",1973,3.5,1,"Bill Melendez","Animation, Comedy, Family, TV Movie","xmtGJz3uMqYmA6pEpZgDWMzbX2E.jpg",13479],["Yours, Mine & Ours",2005,1.5,1,"Raja Gosnell","Comedy, Family, Romance","1SfsoUYXRRrfL31br8q4DlTYvKK.jpg",13499],["Gaslight",1944,4,1,"George Cukor","Thriller, Drama, Mystery, Crime","gXKszCl5Q1KrgWRWpPcqn94CP58.jpg",13528],["Empire Records",1995,2,1,"Allan Moyle","Comedy, Drama, Romance","qKP7hVdjAAvRvbF3GBCbzi5LzMf.jpg",13531],["Sleepaway Camp",1983,3,1,"Robert Hiltzik","Horror","sy2QoyiP58FhVSbyC8CQMPQ8lfn.jpg",13567],["Airheads",1994,3,1,"Michael Lehmann","Comedy, Crime, Music","4xPG8pPMyeoec48gKWbbC85EC8j.jpg",13595],["Labyrinth",1986,2.5,1,"Jim Henson","Adventure, Family, Fantasy","pejayhTVBEL4w8YKSfrhOjjWVlH.jpg",13597],["High School Musical 2",2007,2,1,"Kenny Ortega","Comedy, Family, TV Movie","kqImEYXsDIlzPpu0KxyTXIx7smW.jpg",13649],["Waiting for the Hearse",1985,2,1,"Alejandro Doria","Comedy","qkSThbNiC6kimvLlWrgeTNYLCeq.jpg",13651],["101 Dalmatians II: Patch's London Adventure",2002,1.5,1,"Jim Kammerud","Family, Animation, Adventure, Comedy","uB0DQU4Cog8tYrkiOEVTmDw6Qnn.jpg",13654],["Camp Rock",2008,1,1,"Matthew Diamond","Music, Family, TV Movie","7IXMqZnwccogptThay3togKIFWw.jpg",13655],["The Wolf Man",1941,2,1,"George Waggner","Horror, Drama","vG8fu5syTtQLzK1hQXyi3ugOPNF.jpg",13666],["The Music Man",1962,3.5,1,"Morton DaCosta","Comedy, Family, Music, Romance","4yo6qaqVF1IThXMapo4yW9BRWjV.jpg",13671],["Christmas with the Kranks",2004,1.5,1,"Joe Roth","Comedy, Family","q866vL3KhAjbkZH1enT7AoxmRHx.jpg",13673],["The Game Plan",2007,2,1,"Andy Fickman","Comedy, Family","fcLFvIqCUrhY96mkSmr3okxaMEw.jpg",13680],["Pooh's Heffalump Movie",2005,2,1,"Frank Nissen","Family, Animation, Comedy, Fantasy","5kd5JqccroxOnC9sVMP5NtLrbkr.jpg",13682],["Bottle Rocket",1996,3,1,"Wes Anderson","Comedy, Crime, Drama","wOPiNYt9V3Cbr9Izeddwj7nU8RT.jpg",13685],["Angels with Dirty Faces",1938,3,1,"Michael Curtiz","Crime, Drama","k23E4UAcow8eczLRmVCMdukL4Mx.jpg",13696],["Home on the Range",2004,2,1,"John Sanford","Animation, Family","cgKnkbO3fNWwKc9qLyLYdeZQ9Vj.jpg",13700],["Akeelah and the Bee",2006,2.5,1,"Doug Atchison","Drama","tLejxaLJu8Qh5F2VKacWniMSZ3v.jpg",13751],["The Santa Clause 3: The Escape Clause",2006,1,1,"Michael Lembeck","Comedy, Family, Adventure","pvaWMSRzRwtcxyHKNLX6phiQp8d.jpg",13767],["Best in Show",2000,4,1,"Christopher Guest","Comedy","qkYBCMN26SxkQww4gLxUXQm5vr4.jpg",13785],["Fast & Furious",2009,2,1,"Justin Lin","Action, Crime, Thriller","lUtVoRukW7WNtUySwd8hWlByBds.jpg",13804],["RocknRolla",2008,3,1,"Guy Ritchie","Action, Crime, Thriller","i7eyngqjdvKB7NvrWtCjjTNNq8N.jpg",13809],["Repo Man",1984,2.5,1,"Alex Cox","Comedy, Science Fiction","bjuu5UceuVUNUjnOC2fBzL3hZKC.jpg",13820],["Race to Witch Mountain",2009,1,1,"Andy Fickman","Adventure, Family, Fantasy, Science Fiction, Thriller, Action","5RBZsOKMMxnp8L6UmOiylKOw4yo.jpg",13836],["Sweeney Todd: The Demon Barber of Fleet Street",2007,3.5,1,"Tim Burton","Drama, Horror","gAW4J1bkRjZKmFsJsIiOBASeoAp.jpg",13885],["Return to the Blue Lagoon",1991,1,1,"William A. Graham","Adventure, Drama","jhUTLuPgc3Qcvr5xtji8oiWSfYy.jpg",13888],["Citizen Ruth",1996,3.5,1,"Alexander Payne","Drama, Comedy","hMGWyETjqWpfud4Cmeva6qfVogZ.jpg",13891],["The Circle",2000,3.5,1,"Jafar Panahi","Drama","pTiRBOZ2iI4i26A0qNaEkqmZBpO.jpg",13898],["Luxo Jr.",1986,3,1,"John Lasseter","Animation, Comedy","as8xF0wOawngZ1G3qg5gs0VQea3.jpg",13925],["Red's Dream",1987,3,1,"John Lasseter","Animation, Family","ebPNnYqoEYntnrGdwtmppvBRHpu.jpg",13926],["Tin Toy",1988,2.5,1,"John Lasseter","Animation, Family","yRjtvmRXgZoY8P9Ug28G9OITD9E.jpg",13927],["Knick Knack",1989,3,1,"John Lasseter","Animation, Comedy, Family","uRsPF4LCdKLqwG0Gg2GASMgbZgY.jpg",13928],["Geri's Game",1997,3.5,1,"Jan Pinkava","Animation, Comedy, Family","8PdCk3T9EkcKniUviDogWFCXx28.jpg",13929],["For the Birds",2000,3,1,"Ralph Eggleston","Animation, Family, Comedy","7GogfWZYkZh802fnaMoDBnu8cfV.jpg",13930],["Mike's New Car",2002,2.5,1,"Pete Docter","Animation, Comedy, Family","mOnNx05XOPFeQhOqpbPI0lwEf4N.jpg",13931],["Jack-Jack Attack",2005,2,1,"Brad Bird","Adventure, Animation, Family","uKMYT8aAJS9LA8IM1juMqbXTtqU.jpg",13932],["One Man Band",2005,3.5,1,"Mark Andrews","Animation, Family, Music, Comedy","hfwUfeodlhuYJTYxUbelMLIQbnH.jpg",13933],["Mater and the Ghostlight",2006,2.5,1,"John Lasseter","Animation, Comedy, Family, Horror","thZHluscCvT3SCzVckmFszOVVtM.jpg",13934],["Oklahoma!",1955,2.5,1,"Fred Zinnemann","Western, Music, Romance","ztqT5GmJVI2o8vShGWRVVqykQqA.jpg",13936],["Fly Me to the Moon",2008,1,1,"Ben Stassen","Adventure, Animation, Family","wdjn8YldRIgusHRf8aqdKqriRnp.jpg",13956],["The Last Waltz",1978,4,1,"Martin Scorsese","Documentary, Music","2K7CFH0AIHnGrA4yQjPCoIB5CmQ.jpg",13963],["Jump In!",2007,2,1,"Paul Hoen","Drama, Comedy, Romance","bC15nPOGIOXohhqzC2GTg0DlqIy.jpg",13968],["Captain America",1990,0.5,1,"Albert Pyun","Action, Adventure, Science Fiction, War","vdHrLFfHcJX9nlvUfG3LK2a2hq4.jpg",13995],["Margot at the Wedding",2007,3,1,"Noah Baumbach","Comedy, Drama","IH7wAdM6QoumtWB9CVKg4fUwYl.jpg",13998],["Baraka",1992,4.5,1,"Ron Fricke","Documentary","ldEuJQ4z7zEvL7iXraESWBUfQcz.jpg",14002],["Ex Drummer",2007,2.5,1,"Koen Mortier","Comedy, Crime, Drama, Thriller","7VxXp2h9UtJP6XbeuQGqqbQzoE1.jpg",14019],["Slacker",1990,2.5,1,"Richard Linklater","Drama, Comedy","f7Iov2nd0XX9bp2laQEPYPEhisc.jpg",14022],["Man on Wire",2008,4,1,"James Marsh","Documentary","1mS4rhIgHZcHIvf1beP9Av0Ui33.jpg",14048],["The Girl Who Leapt Through Time",2006,3.5,1,"Mamoru Hosoda","Fantasy, Animation, Drama, Science Fiction","xHnlWM8BmqY419YUccYy2KC5Jqo.jpg",14069],["Zoom",2006,1.5,1,"Peter Hewitt","Family, Comedy, Adventure, Action, Science Fiction","v4rSFmiy0v9D7qmKkaUVJn5UhZ1.jpg",14113],["The Love Bug",1968,1.5,1,"Robert Stevenson","Comedy, Family, Fantasy","9Lc1efdYZUZia2zsRWcUkiD1KdN.jpg",14136],["Timecrimes",2007,2.5,1,"Nacho Vigalondo","Science Fiction, Thriller","zdxQRP7mzczMJBwKnv8MCPRq7rQ.jpg",14139],["Daddy Day Camp",2007,0.5,1,"Fred Savage","Family, Comedy","fhuhSVb3j8SShe6FhnVUAfSRg6h.jpg",14144],["Up",2009,4,2,"Pete Docter","Animation, Comedy, Family, Adventure","mFvoEwSfLqbcWwFsDjQebn9bzFe.jpg",14160],["2012",2009,2,1,"Roland Emmerich","Action, Adventure, Science Fiction","zaqam2RNscH5ooYFWInV6hjx6y5.jpg",14161],["The Adventures of Sharkboy and Lavagirl",2005,2,1,"Robert Rodriguez","Adventure, Family, Science Fiction","xpFbHSkRgOxOoutKqXob9T8iBPA.jpg",14199],["American Movie",1999,4,1,"Chris Smith","Documentary, Comedy","y8dJgWr1HeW0RRxwANDWvgIXdsF.jpg",14242],["Polyester",1981,3,1,"John Waters","Comedy","14RfMqOe8eF17bUajPsy4HtRsVC.jpg",14269],["The Thin Blue Line",1988,4,1,"Errol Morris","Crime, Documentary","4w4BJk3l8y9gYwPPLRs6uPHOmGL.jpg",14285],["You Can Count on Me",2000,4,1,"Kenneth Lonergan","Drama","7mGFmij1FZD5eUnNwvUjmpqrDl6.jpg",14295],["Great Expectations",1946,3,1,"David Lean","Drama, Romance","ynaFuVvW2jaG06pMV67dOhzMYfJ.jpg",14320],["Virgin Territory",2007,0.5,1,"David Leland","Adventure, Action, Comedy, Romance","zofWP7ZKhoVTh2VUltaDo4LRQXc.jpg",14324],["Primer",2004,3.5,1,"Shane Carruth","Science Fiction, Drama, Thriller","xEoq2WmDzpzxhkHEsmOYOg6BPg6.jpg",14337],["Doubt",2008,4,1,"John Patrick Shanley","Drama","9lypT2ghNuUPYVJf66oe4fKvUqI.jpg",14359],["Leviathan",2014,4,1,"Andrey Zvyagintsev","Adventure, Horror, Thriller, Science Fiction","extm7kFsxr0qMoi1G5F3w5Lwlt4.jpg",14372],["Beverly Hills Chihuahua",2008,1,1,"Raja Gosnell","Comedy, Family, Adventure, Romance","2aRvqtLoE06hTjG93lASvO7r1as.jpg",14405],["Sinbad: Legend of the Seven Seas",2003,2,1,"Tim Johnson","Action, Adventure, Animation, Family, Fantasy","yiW2L1fDiBT7AeWXrykhTNtPrr8.jpg",14411],["Séraphine",2008,3.5,1,"Martin Provost","History, Drama","nSA2iRp6BxhqDPzJsdk6CXALgjr.jpg",14415],["Zulu",1964,3.5,1,"Cy Endfield","Drama, History, War","9V7tl1kIb67ZPRRNlUdy3JvqEiA.jpg",14433],["Ella Enchanted",2004,2,1,"Tommy O'Haver","Family, Fantasy, Comedy","7AyNzwSEpJEG1gBdgwRfXi1cjs8.jpg",14442],["The Rugrats Movie",1998,2,1,"Norton Virgien","Adventure, Animation, Comedy, Family","uZejGKCSd6nwfMx8U0Td37U2fTc.jpg",14444],["A Matter of Loaf and Death",2008,3.5,1,"Nick Park","Family, Animation, Comedy, Mystery, Romance","egKYj3L9HMsHjHXk3tYMU0O87g8.jpg",14447],["The Adventures of Baron Munchausen",1988,3,1,"Terry Gilliam","Fantasy, Adventure, Comedy","oiOwGRqwrKpg1EMUlPgRjVC49bn.jpg",14506],["From Beyond",1986,3.5,1,"Stuart Gordon","Horror, Science Fiction","zwmyxaKzIRLD4iUqZAQW940omdm.jpg",14510],["Harakiri",1962,4.5,2,"Masaki Kobayashi","Action, Drama, History","3nPwMd3KviJWaHzG9fZCqlwWMas.jpg",14537],["Bad Day at Black Rock",1955,4,1,"John Sturges","Western, Drama, Crime, Mystery, Thriller","8EnhHjU0DyCckmZRtn46s3WXeEf.jpg",14554],["The Boy in the Striped Pyjamas",2008,2.5,1,"Mark Herman","Drama, War, History","2C8QCXdMlojTxZjfBlINr4FWcb6.jpg",14574],["Dirty Work",1998,1.5,1,"Bob Saget","Comedy","r6OcS6TQCHal2wHooJhHWSlFzfd.jpg",14577],["The Big Heat",1953,4,1,"Fritz Lang","Crime, Thriller","ezt6fb4JbghGKmaMzzuMtxpz0Kb.jpg",14580],["Fury",1936,3.5,1,"Fritz Lang","Crime, Drama, Thriller","u1kjLTUqmqjDMlRxcwCqWagjf6r.jpg",14615],["Beau Travail",1999,4.5,1,"Claire Denis","Drama","q8yqNHupN2sm8sAACvsTgCAXnoq.jpg",14626],["Ten",2002,3.5,1,"Abbas Kiarostami","Drama","6qOJ6COcbJ3X8JmZI6A7VroGsn2.jpg",14633],["Slums of Beverly Hills",1998,4.5,2,"Tamara Jenkins","Comedy, Drama","bTY6I0Mju4vTRHGoTZrNtxtAlAO.jpg",14662],["Ugetsu",1953,3.5,1,"Kenji Mizoguchi","Fantasy, Drama, Mystery","r8RiuKTIYIJBjczBVsfeP5C00CJ.jpg",14696],["Streets of Fire",1984,3.5,1,"Walter Hill","Action","tmYHBKCZkbmiUfhfOQKgfh0jvXK.jpg",14746],["Ip Man",2008,3,1,"Wilson Yip","Drama, Action, History","zyQQ7wFuCvH6MzJcUKy6N6ouMYs.jpg",14756],["Tom and Jerry: The Magic Ring",2001,1.5,1,"James T. Walker","Animation, Comedy, Family, Fantasy","fF6I48WGKktHfGYYSVKPTVildWE.jpg",14787],["George Lucas in Love",1999,3.5,1,"Joe Nussbaum","Drama, Comedy, Romance","umumYQuZjFvC1TLzclBesdIuaFR.jpg",14792],["Vitus",2006,3,1,"Fredi M. Murer","Music, Drama","7t5heYtCikNOASRM0KQfXgmD6ge.jpg",14804],["Fiddler on the Roof",1971,4,1,"Norman Jewison","Drama, Romance","v65PHx7Q6Jx0anyNeUOX07SJic9.jpg",14811],["Help!",1965,3.5,1,"Richard Lester","Comedy, Music, Adventure","nLvgIB3bVb8jyhls5W6B74Xt4Ei.jpg",14831],["Coraline",2009,4,1,"Henry Selick","Animation, Horror, Fantasy, Family","4jeFXQYytChdZYE9JYO7Un87IlW.jpg",14836],["Chasing Liberty",2004,1.5,1,"Andy Cadiff","Comedy, Romance","aGh5zpJSuxcx4lzFFbZ2QyY8wQP.jpg",14844],["G.I. Joe: The Rise of Cobra",2009,1.5,1,"Stephen Sommers","Adventure, Action, Thriller, Science Fiction","mc9b25IAprHfsaOz0wTshOwGHcY.jpg",14869],["The Jungle Book 2",2003,2,1,"Steve Trenbirth","Family, Animation, Adventure","21GanxizOIL1CN0HLx7j3je8k87.jpg",14873],["The Last Detail",1973,3,1,"Hal Ashby","Drama, Comedy","zQoNkO99qfaBjh5aoA0pKau1prp.jpg",14886],["Saludos Amigos",1942,3.5,1,"Norman Ferguson","Animation, Adventure, Music","kdZyHjsSHYBO53o59ZMz4fOXcmk.jpg",14906],["Batman: Mask of the Phantasm",1993,3.5,1,"Bruce Timm","Animation, Crime, Mystery","hT4ehUteagUrhUOHAtmYiY7mp5l.jpg",14919],["Uptown Girls",2003,3,1,"Boaz Yakin","Comedy, Drama","dDdrQZFp81Jus9CgCzfWmmarehe.jpg",14926],["Rachel Getting Married",2008,3.5,1,"Jonathan Demme","Drama, Romance","bumaq3lqe4YSsq6LlYoge7e9ABk.jpg",14976],["Barbie as Rapunzel",2002,2,1,"Owen Hurley","Animation, Family","ysiGzuMSc0nFmmDPn9z7U7YSFYf.jpg",15015],["Futurama: Into the Wild Green Yonder",2009,3,1,"Peter Avanzino","Animation, Comedy, Science Fiction","oL6SymcxQE6TN9KrrbdyhlulnEG.jpg",15060],["The Good, the Bad, the Weird",2008,3.5,1,"Kim Jee-woon","Action, Adventure, Comedy, Western","lbPZ0aNoF0cHisg6DubFO2eS8so.jpg",15067],["Only Yesterday",1991,5,1,"Isao Takahata","Animation, Drama, Romance","tOSnFE9e82iH3ZAzSTtuOkBsabJ.jpg",15080],["The Sound of Music",1965,4,1,"Robert Wise","Drama, Family, Music, Romance","c6CrUZypAsBCaRWX0M3RVRDbhNS.jpg",15121],["Evangelion: 1.0 You Are (Not) Alone",2007,3,2,"Hideaki Anno","Animation, Science Fiction, Action, Drama","pETU4GurpeEjBOM8oytMH0yNBHx.jpg",15137],["Sixteen Candles",1984,2,1,"John Hughes","Comedy, Romance","A3WGCAgJF33kZdlxUdyXHYdbYax.jpg",15144],["OSS 117: Cairo, Nest of Spies",2006,3,1,"Michel Hazanavicius","Crime, Action, Adventure, Comedy","dDVHVZVEbTV4JsB8ZjdXNmMK7rA.jpg",15152],["The Pink Panther 2",2009,1.5,1,"Harald Zwart","Comedy, Mystery","qWhI9kn5OtxWB208Z88xAyhOJ68.jpg",15159],["Barbie as The Princess & the Pauper",2004,2,1,"William Lau","Animation, Family, Comedy","xHYsUwUe4MaNc6mbNBGTkqZSnPk.jpg",15165],["Barbie in the Nutcracker",2001,2,1,"Owen Hurley","Animation, Family","eIkXJggVmzN4MyPgJ2kDjOy9lmQ.jpg",15167],["Hotel for Dogs",2009,1,1,"Thor Freudenthal","Comedy, Family","xD2AssTeySNCamlGueai4yAZZfX.jpg",15189],["Clue",1985,3,1,"Jonathan Lynn","Comedy, Thriller, Crime, Mystery","aRxbYOYHS8T73nzR8hsLousoplR.jpg",15196],["Bathory: Countess of Blood",2008,1,1,"Juraj Jakubisko","Drama, Fantasy","qZsQ02liDzz9Ydb1dzFwLxef7me.jpg",15208],["A Man Escaped",1956,4,1,"Robert Bresson","Drama, Thriller","gkoZ8fFib24zhB2DKpjQ09SK9FU.jpg",15244],["The Red Balloon",1956,4.5,1,"Albert Lamorisse","Comedy, Drama, Family, Fantasy","3XrEggEOEnKGi8hTOau44vcvbmV.jpg",15265],["Pom Poko",1994,4,1,"Isao Takahata","Adventure, Animation, Fantasy","zat2MMhejQyJJN6CucLI9Or9kdo.jpg",15283],["Twilight Zone: The Movie",1983,2.5,1,"Steven Spielberg","Horror, Fantasy, Science Fiction","sDWARc5aYTUKE8Y2FIGVgWXuI4K.jpg",15301],["The Pixar Story",2007,3.5,1,"Leslie Iwerks","Documentary","vhK51wJybwZTRCPVUOkGpSI4auN.jpg",15302],["The Cat Returns",2002,2.5,1,"Hiroyuki Morita","Adventure, Fantasy, Animation, Drama, Family","pqyY7IEWkCWNZ7EuRStQaJITEta.jpg",15370],["The Castle of Cagliostro",1979,3,1,"Hayao Miyazaki","Animation, Adventure, Comedy, Crime","hSFdyWptoDHuXlFZGzIrfVell4Q.jpg",15371],["White Mane",1953,2.5,1,"Albert Lamorisse","Drama, Family","rABMUyq9E52qrs62HXw3oFkwgNO.jpg",15382],["Mickey's Once Upon a Christmas",1999,2.5,1,"Bradley Raymond","Animation, Family, Comedy","b6h6HwucncSxn06sMNROJ9apLC5.jpg",15400],["Becket",1964,3,1,"Peter Glenville","Drama, History","swWmxVbq0pXv4wwsc2O803PiXR7.jpg",15421],["Shadows",1958,3,1,"John Cassavetes","Drama","zR1gHOGVruoROCdHS7Tc5TSZqED.jpg",15484],["Monsters vs Aliens",2009,2.5,1,"Rob Letterman","Animation, Family, Adventure, Science Fiction","hpHarddVj34j53T7NsoUGdKj4mP.jpg",15512],["Stitch! The Movie",2003,1.5,1,"Bobs Gannaway","Animation, Family, Comedy, Science Fiction","flwMGZcOO80lqsnZ6lIwsKja5N.jpg",15567],["Missing",1982,4,1,"Costa-Gavras","Drama, Mystery, Thriller","fAAhC4RkpXu7SJgIESWQwVxcelo.jpg",15600],["An Extremely Goofy Movie",2000,2,1,"Douglas McCarthy","Animation, Family, Comedy","qr5Q3S7HC16XHQBqE4ZsJJvgUDU.jpg",15653],["Tarzan II",2005,1.5,1,"Brian Smith","Adventure, Animation, Family","dI0ANmiLaqUuBrX4v8V3ZywkyZ0.jpg",15657],["Annie",1982,2.5,1,"John Huston","Comedy, Drama, Family","xopqD99S1GqQOG8UAeSElsX9MeP.jpg",15739],["Sophie's Choice",1982,2.5,1,"Alan J. Pakula","Drama, Romance, War","rZDPbPTFwuKgr5b9jixGFNYkGYt.jpg",15764],["Ghidorah, the Three-Headed Monster",1964,3,1,"Ishirō Honda","Science Fiction, Action, Fantasy","qkI5nhvxx3233gQmoQvv0W3MB7A.jpg",15766],["A Goofy Movie",1995,3,1,"Kevin Lima","Adventure, Comedy, Romance, Animation, Family","bycmMhO3iIoEDzP768sUjq2RV4T.jpg",15789],["White Heat",1949,3,1,"Raoul Walsh","Crime, Drama, Thriller","v7cPOHKKZI9qChi7HDUxNIhEcLR.jpg",15794],["A Brighter Summer Day",1991,4,1,"Edward Yang","Crime, Drama, Romance","3l8fOAwiN3N5n3hHnZ51eog7Zu2.jpg",15804],["The Mummy (1932)",1932,2,1,"Karl Freund","Horror, Fantasy","vSKpbZVvzqQcw6htiyEinbCY9vq.jpg",15849],["House on Haunted Hill",1959,3.5,1,"William Castle","Horror, Mystery","g5kdFt3piV3w1pG65W9sSToJ7HB.jpg",15856],["Interiors",1978,3,1,"Woody Allen","Drama","sTPy6Kfa1FRED1eaZdVex8b2MdB.jpg",15867],["Angel's Egg",1985,3.5,1,"Mamoru Oshii","Animation, Fantasy, Mystery, Science Fiction","dcEUGvckbePFzPKhGXnS9T3kZMG.jpg",15916],["The Three Caballeros",1944,2.5,1,"Norman Ferguson","Animation, Family, Music","nMfScRxw9wVLoO7LiEjziFAKLSK.jpg",15947],["Carnival of Souls",1962,4,1,"Herk Harvey","Horror, Mystery, Fantasy","9ddPGH7kMe81xznwIKCt17VFUPi.jpg",16093],["Alice Doesn't Live Here Anymore",1974,3.5,1,"Martin Scorsese","Romance, Drama","A99yzz1W3NCG6zR2HXSwn2kWlse.jpg",16153],["The Happiness of the Katakuris",2001,4,1,"Takashi Miike","Comedy, Drama, Horror","8iIei17w5DVEz4P9OjxIM10f7Jh.jpg",16184],["Buzz Lightyear of Star Command: The Adventure Begins",2000,1.5,1,"Tad Stones","Action, Adventure, Animation, Comedy, Family, Science Fiction, TV Movie","q3KKUunEhdmOob17JbGB1kgPfdJ.jpg",16187],["My Neighbors the Yamadas",1999,3,1,"Isao Takahata","Animation, Comedy, Family","nj0ijnOozQtu52r0ncut769G1FX.jpg",16198],["Wizards",1977,2.5,1,"Ralph Bakshi","Animation, Fantasy, Science Fiction","jeAxoYepnVirGe0H7pmwviSZYul.jpg",16220],["Holiday",1938,4,1,"George Cukor","Comedy, Romance, Drama","vTswoixIge9o84NLlWGaWl5lrHO.jpg",16274],["Creepshow",1982,2.5,1,"George A. Romero","Horror, Comedy","4SoyTCEpsgLjX6yAyMsx3AsAyRQ.jpg",16281],["Sullivan's Travels",1941,3.5,1,"Preston Sturges","Comedy, Romance, Adventure","z5cqIM0ysVjkCmaDfyTQnlozdIp.jpg",16305],["Fantastic Planet",1973,4,1,"René Laloux","Animation, Science Fiction","prq0j1S0K07UjwLZLF6oMGflRUI.jpg",16306],["The Wicker Man",1973,3.5,1,"Robin Hardy","Horror","wwtrXRL8SiOWxhwLEvw7iBgYh0g.jpg",16307],["The Texas Chainsaw Massacre 2",1986,3,1,"Tobe Hooper","Horror, Comedy","cO1Dvg7k87lHSPOdumn3ddJEKdX.jpg",16337],["Rugrats in Paris: The Movie",2000,1.5,1,"Stig Bergqvist","Adventure, Animation, Comedy, Family, Romance","grIL8mvfLznaWsv7EEEPhCpkH81.jpg",16340],["Joseph: King of Dreams",2000,2.5,1,"Rob LaDuca","Family, Animation, Drama","ou0JqPXFbQcphqkMx1grfsmeJFX.jpg",16366],["The Innocents",1961,4.5,1,"Jack Clayton","Horror, Mystery, Drama","idqvLBmlEHUITMnQ0EJ6Yb5TpVw.jpg",16372],["The Rutles: All You Need Is Cash",1978,3,1,"Eric Idle","Comedy, Music, TV Movie","z2ofR1L726kKTjavmflW7vzWomJ.jpg",16378],["Black Narcissus",1947,3.5,1,"Michael Powell & Emeric Pressburger","Drama","jSbFWWbkUq5N5ikewJHNATcWnxS.jpg",16391],["Waiting for Guffman",1996,3.5,1,"Christopher Guest","Comedy, Music","zuArI6EBpV6mExrvfnyidoOtzdf.jpg",16448],["Roundhay Garden Scene",1888,2.5,1,"Louis Aimé Augustin Le Prince","Documentary","qI9eTP3NpJlxTk3oMBvfz8Awwkw.jpg",16463],["Traffic Crossing Leeds Bridge",1888,2,1,"Louis Aimé Augustin Le Prince","Documentary","cw7uvqK3orqVUlULmA8OfkecMRY.jpg",16464],["The Infernal Cauldron",1903,2.5,1,"Georges Méliès","Fantasy, Horror","3KS5ZLXSB0iRKO5MSda8xxgLg2K.jpg",16465],["The Spirit of Christmas: Jesus vs. Frosty",1992,2,1,"Trey Parker","Animation, Comedy, Thriller","5NpBk74KE57HWcmXmdc0A4QG8GS.jpg",16486],["The Spirit of Christmas: Jesus vs. Santa",1995,2.5,1,"Trey Parker","Animation, Comedy","1ZjjFcUZpoWOuVjYcUuiF2oEmNj.jpg",16487],["Captains Courageous",1937,3,1,"Victor Fleming","Adventure, Drama, Family","qhJNHLwIcMqDKBwsr9uMDOumO33.jpg",16515],["Where the Wild Things Are",2009,3.5,1,"Spike Jonze","Adventure, Drama, Family, Fantasy","sDFV9VEjwTUWF1s5sjOllsb70jk.jpg",16523],["Boy",2010,3.5,1,"Taika Waititi","Animation, Action, Family, Science Fiction","6AK3uOHaIbl6EDaytHYe4FinZMu.jpg",16577],["Blacksmithing Scene",1893,2,1,"William K.L. Dickson & William Heise","Drama","c76bs0S90EFhB5ww3i6DlYQTVk.jpg",16624],["Days of Heaven",1978,4.5,1,"Terrence Malick","Drama, Romance","rwxTYjOZmX2rGhz7avLe1qsjNqe.jpg",16642],["Russian Ark",2002,3,1,"Aleksandr Sokurov","Drama, Fantasy, History","dkFM8Q7J0wNpEnbtD1AcWumkShj.jpg",16646],["All About Lily Chou-Chou",2001,3.5,1,"Shunji Iwai","Drama, Crime","pLBNmJUH9JYRCRsh349PJ22WpkS.jpg",16664],["Woman in the Dunes",1964,5,1,"Hiroshi Teshigahara","Drama, Thriller","f0JpsMQ9oEjKBD66Ky3qK3z7LGT.jpg",16672],["Return to Never Land",2002,2,1,"Robin Budd","Adventure, Fantasy, Animation, Family","wB3r2b8sxUZspqNyr8copMlt7se.jpg",16690],["Departures",2008,3,1,"Yojiro Takita","Drama","mms4nMZuPYOyEengRxCaEk7SXMd.jpg",16804],["All That Jazz",1979,5,3,"Bob Fosse","Drama","culCEdj4srLljefgn4XKd6k3C5t.jpg",16858],["Kiki's Delivery Service",1989,4.5,2,"Hayao Miyazaki","Animation, Family, Fantasy","Aufa4YdZIv4AXpR9rznwVA5SEfd.jpg",16859],["Planet 51",2009,1.5,1,"Jorge Blanco","Animation, Family, Comedy, Science Fiction, Adventure","x7Itcg3ZdExKwdKguy73WPEqosW.jpg",16866],["Inglourious Basterds",2009,5,4,"Quentin Tarantino","Drama, Thriller, War","7sfbEnaARXDDhKm0CZ7D7uc2sbo.jpg",16869],["Drag Me to Hell",2009,4.5,1,"Sam Raimi","Horror, Thriller","fdyejM5Zd6dsa0YyWa02ZAKwQzK.jpg",16871],["Black Christmas",1974,3,1,"Bob Clark","Horror, Mystery, Crime","qqO98sdPgptFgCua3Z4uZDuPcmP.jpg",16938],["The Asphalt Jungle",1950,3,1,"John Huston","Crime, Drama","8xsUnT0P2fJWQv9jGDhs3i9Zx2l.jpg",16958],["Fat City",1972,3,1,"John Huston","Drama","7ag7BOMnAuDKwNyI0wc8jTeimRb.jpg",16993],["I'll Be Home for Christmas",1998,1,1,"Arlene Sanford","Comedy, Family","9hTYFvEDnajUIbpdfc3fO6bZq2Y.jpg",17037],["Agent Cody Banks 2: Destination London",2004,1,1,"Kevin Allen","Action, Adventure, Comedy, Family","zlAltvp84rYVTYs3kdemqHBaiat.jpg",17047],["In a Lonely Place",1950,3.5,1,"Nicholas Ray","Thriller, Drama, Romance, Mystery","vbdgtwzLOpE6MppZlyYChMagvQq.jpg",17057],["Scarlet Street",1945,3.5,1,"Fritz Lang","Drama, Crime","eGEDor1BWSQGaLtOntPHUSqNzRC.jpg",17058],["The Woman in the Window",1944,2.5,1,"Fritz Lang","Crime, Drama, Thriller","i8jDpAWByVYaQZJXbsg8XqDOF5y.jpg",17136],["Gigi",1958,2,1,"Vincente Minnelli","Comedy, Romance","3GSuecnDr4N5ZaqTrwElSzt6eC2.jpg",17281],["The Battle of Algiers",1966,4,1,"Gillo Pontecorvo","Drama, War, History","2p3AFtOHFvP6OeVMqlnL1zLKOqL.jpg",17295],["Escape to Victory",1981,4,1,"John Huston","Drama, War","3j6H0dnbvjNXLK1l9nKguXw5vvO.jpg",17360],["The Parallax View",1974,4,1,"Alan J. Pakula","Crime, Drama, Thriller","6Ef0w6xcBbRUiKQkSSECw7xjsg3.jpg",17365],["Moon",2009,4.5,1,"Duncan Jones","Science Fiction, Drama","35IU0Mq0zFsN1mYwDGts5mKc77n.jpg",17431],["...And Justice for All",1979,2.5,1,"Norman Jewison","Drama","32NmJn0p4o9BdWVpEhuyxzwsqhL.jpg",17443],["Blame It on Fidel!",2006,3,1,"Julie Gavras","History, Drama","cMhgXisVDyoOGaXzFe0x1SAifF4.jpg",17460],["Riki-Oh: The Story of Ricky",1991,2.5,1,"Lam Nai-Choi","Action, Science Fiction, Horror","dzG0PAbBDLbJSYuv2SM2Mjxw2MH.jpg",17467],["The Man in the Moon",1991,2.5,1,"Robert Mulligan","Drama, Romance","57r0TXlqV5GIn4h0Htgh81OZou9.jpg",17474],["The Adventures of Tintin",2011,3.5,1,"Steven Spielberg","Adventure, Animation, Mystery","fQZ3sLR1Fi63NMsNRbjm9q5qODJ.jpg",17578],["Deathtrap",1982,2.5,1,"Sidney Lumet","Comedy, Crime, Drama","fwrqCTcu5rAkU2dL2YqG6jjrLPn.jpg",17590],["Antichrist",2009,2.5,1,"Lars von Trier","Drama, Horror, Thriller","ge7zbYvpfsDP3luKi0iSpzOgncM.jpg",17609],["Year One",2009,1.5,1,"Harold Ramis","Comedy, Adventure","qF573jdJYwtCbXVXPDn4xu8nW2a.jpg",17610],["District 9",2009,4,1,"Neill Blomkamp","Science Fiction","tuGlQkqLxnodDSk6mp5c2wvxUEd.jpg",17654],["Fleetwood Mac: The Dance",1997,3.5,1,"Bruce Gowers","Music","cESxEjxiBn2y7ok6wN6suQl9N1.jpg",17671],["The Girlfriend Experience",2009,3.5,1,"Steven Soderbergh","Drama","rDxSasCAEdXpaeEo3GsBt8i9wkr.jpg",17680],["Jaws 3-D",1983,1.5,1,"Joe Alves","Thriller, Horror","kqDXj53F9paqVGJLGfHtz7giJ3s.jpg",17692],["Hey Arnold! The Movie",2002,2,1,"Tuck Tucker","Animation, Comedy, Family, Adventure, Drama, Thriller","etxcq4qiFNi5p0q71APw8MNzPPT.jpg",17710],["The Adventures of Rocky & Bullwinkle",2000,1,1,"Des McAnuff","Adventure, Animation, Comedy, Family","xCFSsftt2rglC81I6QLWcZSTCBM.jpg",17711],["Assault on Precinct 13",1976,4,1,"John Carpenter","Thriller, Action, Crime","hT4Ry5rN1eoAEvZaevuFAYY7SYa.jpg",17814],["A Simple Wish",1997,1.5,1,"Michael Ritchie","Adventure, Comedy, Family, Fantasy","cfyJ7yIvNTlz2ooH8iU6r0pxAMj.jpg",17834],["Because of Winn-Dixie",2005,2,1,"Wayne Wang","Family, Comedy, Drama","oMUFS7HmIyTeui5xuoIEkPYTWC8.jpg",17880],["Oliver!",1968,3,1,"Carol Reed","Drama, Family","1XJgoaOWKrqxkKeBKWLKSigqG8c.jpg",17917],["After Life",1998,3.5,1,"Hirokazu Kore-eda","Fantasy, Drama","bs2M1hqAQl5LeAOPPRV4drwouZS.jpg",17962],["A Christmas Carol",2009,3,1,"Robert Zemeckis","Animation, Drama, Family, Fantasy","xNwlAIdx1Ln28GRiQttUP9Gojy2.jpg",17979],["Christmas",2009,2.5,1,"Sebastián Lelio","Animation, Drama, Family, Fantasy","xNwlAIdx1Ln28GRiQttUP9Gojy2.jpg",17979],["Kiss Me Deadly",1955,2.5,1,"Robert Aldrich","Mystery, Thriller, Crime","z7me91nrpWLHY1mZOB2v20cK0zY.jpg",18030],["Nine Queens",2000,4,1,"Fabián Bielinsky","Crime, Thriller, Drama","u2L4Foderu7SCPci5c3jsUfEJPP.jpg",18079],["Tokyo Story",1953,3.5,1,"Yasujirō Ozu","Drama","g2YbTYKpY7N2yDSk7BfXZ18I5QV.jpg",18148],["Earth vs. the Flying Saucers",1956,2,1,"Fred F. Sears","Action, Science Fiction","qCOLglZvQgQAyWMCZodBo3wmgqp.jpg",18158],["Land of the Lost",2009,1,1,"Brad Silberling","Adventure, Science Fiction, Comedy, Action","hVCJzmK9l5FD01LFYAB1zcmmw7s.jpg",18162],["Like Water for Chocolate",1992,3,1,"Alfonso Arau","Drama, Romance","itwUdMqLmPfhtGJ44hiDxkqZhiq.jpg",18183],["Running on Empty",1988,4,1,"Sidney Lumet","Drama, Romance, Crime","kzhyruFxY4Z5Ert8M9tuM2MV8dd.jpg",18197],["The Twilight Saga: New Moon",2009,1,1,"Chris Weitz","Adventure, Fantasy, Drama, Romance","k2qTooPlHffgNABNWxeJdGMglPK.jpg",18239],["The Proposal",2009,1.5,1,"Anne Fletcher","Comedy, Romance, Drama","6stnAm1wSek8ZrislwK4xGTyCnt.jpg",18240],["Lady and the Tramp II: Scamp's Adventure",2001,1.5,1,"Darrell Rooney","Animation, Family, Romance, Adventure","nS3nhUZUSY8dWEsRmKILfiOC3F0.jpg",18269],["Downloading Nancy",2008,2,1,"Johan Renck","Drama, Romance, Thriller","11unuBv9a4wbH6BA3zQNk3ywb9m.jpg",18273],["Godzilla vs. Biollante",1989,3,1,"Kazuki Ōmori","Action, Horror, Science Fiction","me4CanEAtNm03LXlFJOyhX3FsMF.jpg",18289],["George Washington",2000,4,1,"David Gordon Green","Drama","g9nZi8u5LqSrVKEpSm199EM4hk5.jpg",18292],["Love in the Afternoon",1957,2.5,1,"Billy Wilder","Comedy, Romance","jCHVviBhRQ7OkJFQfziO2N2ZJmh.jpg",18299],["Happy Together",1997,3.5,2,"Wong Kar-Wai","Drama, Romance","kO4KjUkQOfWSBw06Bdl7m6AlEP7.jpg",18329],["The Nutty Professor",1963,2,1,"Jerry Lewis","Comedy, Science Fiction","a3lzU19j7WGfyXVDfPMdh8DAkru.jpg",18331],["Hour of the Wolf",1968,4.5,1,"Ingmar Bergman","Drama, Horror","jSqTnEP1x1OcOglqrInYvGSF1tL.jpg",18333],["Night at the Museum: Battle of the Smithsonian",2009,2,1,"Shawn Levy","Adventure, Fantasy, Action, Comedy, Family","l9yAQn6TyrA3gv5xZZkiMMoZsiw.jpg",18360],["Gummo",1997,4.5,1,"Harmony Korine","Drama, Comedy","tMdoCRx0XIPR5uYBwxbxR7WCNBb.jpg",18415],["Brüno",2009,3.5,1,"Larry Charles","Comedy","wcUc7TYtsb72dHVb51sYaGIvQsr.jpg",18480],["Neon Genesis Evangelion: The End of Evangelion",1997,4,2,"Hideaki Anno","Animation, Science Fiction, Drama, Fantasy","j6G24dqI4WgUtChhWjfnI4lnmiK.jpg",18491],["Chronos",1985,3,1,"Ron Fricke","Documentary","ciGeeT92K7wMu8wAJntoizImwvG.jpg",18493],["Bronson",2008,4,1,"Nicolas Winding Refn","Drama, Action, Crime","zoWdemYy4qV5lUcLWXpeYhms0Xe.jpg",18533],["Morvern Callar",2002,3.5,1,"Lynne Ramsay","Drama","mQqOG4w5xAlmtIxRUqodECYuJ5l.jpg",18602],["One-Eyed Jacks",1961,3.5,1,"Marlon Brando","Western, Drama","xal47bRKVIxErB7h2CScY3GBnoT.jpg",18647],["The Lizzie McGuire Movie",2003,2,1,"Jim Fall","Family, Comedy","ecDrdzRhl01fck3Bwd3pn9Qm3Un.jpg",18736],["Twin Dragons",1992,2.5,1,"Ringo Lam Ling-Tung","Action, Comedy, Crime","tm153lMrHy6HykEYwoP0EI3dQ8k.jpg",18764],["The Hangover",2009,3,1,"Todd Phillips","Comedy","A0uS9rHR56FeBtpjVki16M5xxSW.jpg",18785],["Dr. Dolittle 3",2006,1,1,"Rich Thorne","Comedy, Family, Fantasy","mODEH6RuoL8s9ptF1Mbrq1Z6aYz.jpg",18843],["Alice",1988,3.5,1,"Jan Švankmajer","Animation, Fantasy, Adventure","8o460rJZt7GY3j7QmLPeJrQWNwD.jpg",18917],["Ernest Goes to Camp",1987,2.5,1,"John Cherry","Comedy, Family","14GzgM3U2ABJ3h4ixhOkWpoQJAj.jpg",18935],["Nirvana: Unplugged In New York",1993,3.5,1,"Beth McCarthy-Miller","Music, Documentary","6WIYa58aG4wW7NaTGsgPo5ZT7Ad.jpg",18942],["The Boat That Rocked",2009,2.5,1,"Richard Curtis","Drama, Comedy","l7CBRLAXUnHi0kp2krhLtlJvtWI.jpg",18947],["Dimensions of Dialogue",1983,4,1,"Jan Švankmajer","Animation, Comedy, Drama, Horror, Fantasy","frllemYfEue2vgcqKUY5HASb2ub.jpg",19035],["All Dogs Go to Heaven 2",1996,2,1,"Larry Leker","Romance, Animation, Family, Adventure, Fantasy","kNmIJILOW9qF2F1Z0qOXkadaS50.jpg",19042],["The Duellists",1977,3.5,1,"Ridley Scott","Drama, War","nqjMYlUXnmmO8Jqucow4nj9alE5.jpg",19067],["Juliet of the Spirits",1965,3.5,1,"Federico Fellini","Comedy, Drama, Fantasy","NbN10moPWQiiIKDJsC7A3j4Mcy.jpg",19120],["Hellzapoppin'",1941,3.5,1,"H. C. Potter","Music, Comedy, Romance","O5Ta3URiRglqt1fPi2APCvnb8x.jpg",19136],["Goal III: Taking on the World",2009,0.5,1,"Andrew Morahan","Drama","uYXkXYOxe79aTcTSPGeV4TMc5sM.jpg",19139],["Nightmare Alley",1947,3.5,1,"Edmund Goulding","Drama, Thriller, Crime","odlV13MZEswVyMBQ4fmmxLRHYT0.jpg",19169],["Away We Go",2009,3,1,"Sam Mendes","Drama, Comedy, Romance","bcN8sdoAPZae2Et1klD0iWRdSnZ.jpg",19255],["Whatever Works",2009,3,1,"Woody Allen","Comedy, Romance","upIYOZbiutCBnvejGYaZlJxxKcs.jpg",19265],["Saving Face",2004,3.5,1,"Alice Wu","Comedy, Romance, Drama","7XbbgkKi4nEMOu9iwiANXpjKKhe.jpg",19316],["We Will Rock You",1982,3,1,"Saul Swimmer","Music","wcHraddPeYdjw1gqg7OYcOEu82T.jpg",19352],["The Adventures of Prince Achmed",1926,3.5,1,"Lotte Reiniger","Animation, Adventure, Fantasy, Romance","dcSO73krnaIjLcD2lyT9nu4zY8R.jpg",19354],["Josie and the Pussycats",2001,2,1,"Deborah Kaplan","Comedy, Music","dYwbqjnSFsvCGok8gsqRcY8ewTU.jpg",19366],["Nights of Cabiria",1957,4.5,2,"Federico Fellini","Drama, Comedy","xF4oCG3PLNbcrtPZbqB3BtkIbKg.jpg",19426],["Princess Protection Program",2009,1.5,1,"Allison Liddi-Brown","Family, TV Movie, Comedy, Drama","tPKD9hmuYxclAQnfup47qLx8a5T.jpg",19458],["Son of the Bride",2001,4,1,"Juan José Campanella","Comedy, Drama, Romance","zXInKuQ8FW18Ko8CtY9V30qhz1P.jpg",19460],["The Red Shoes",1948,4,1,"Michael Powell & Emeric Pressburger","Drama, Romance","b7x6Wq9Mss2hOgf0fnVX7gBagJw.jpg",19542],["Miss March",2009,1.5,1,"Zach Cregger","Comedy, Romance","rJovsKIjVsSMuwURASoTZJB6jvI.jpg",19556],["G-Force",2009,1.5,1,"Hoyt Yeatman","Family, Fantasy, Action, Adventure, Comedy","9Tly3ZXTTsQKM26fis8v9LR4GxG.jpg",19585],["Rodan",1956,2.5,1,"Ishirō Honda","Horror, Science Fiction","tcSSYYFsRrQCvy2HskkwpY29NnB.jpg",19742],["Inspector Gadget 2",2003,0.5,1,"Alex Zamm","Action, Adventure, Comedy, Family","6g5L4lpsQ1jYDJpMn1XGYOGzlar.jpg",19766],["Couples Retreat",2009,1,1,"Peter Billingsley","Comedy, Romance","igXVSRZsNX3TZsKrQqSyEJvzHRF.jpg",19899],["Zombieland",2009,3.5,2,"Ruben Fleischer","Comedy, Horror","dUkAmAyPVqubSBNRjRqCgHggZcK.jpg",19908],["(500) Days of Summer",2009,4,1,"Marc Webb","Comedy, Drama, Romance","qXAuQ9hF30sQRsXf40OfRVl0MJZ.jpg",19913],["Surrogates",2009,2,1,"Jonathan Mostow","Science Fiction, Action, Thriller","v3Z0Hbl0oe57njrrIPh0fJPFoo.jpg",19959],["Jennifer's Body",2009,3.5,2,"Karyn Kusama","Horror, Comedy","wrkjsGcFJxcQqR56kJUYAEKKg2T.jpg",19994],["Avatar",2009,4,2,"James Cameron","Science Fiction, Action, Adventure","gKY6q7SjCkAU6FqvqWybDYgUKIF.jpg",19995],["Au Hasard Balthazar",1966,3.5,1,"Robert Bresson","Drama","lkLO1HDzzaXpTXtAgnGpVqIQkvF.jpg",20108],["Deep Red",1975,4,1,"Dario Argento","Horror, Mystery, Thriller","wq7RxV5gMvgO0EKeWpNhegnpJBh.jpg",20126],["Life Is a Miracle",2004,4.5,1,"Emir Kusturica","Romance, Drama, Comedy","wyPG79yFyq0zj4qWXD2CkCj0nTJ.jpg",20128],["The Children's Hour",1961,4.5,1,"William Wyler","Drama","goyEWixvULM2IRN4KsKibyrJE4J.jpg",20139],["Mac and Me",1988,0.5,1,"Stewart Raffill","Family, Fantasy, Science Fiction, Adventure","gZsIgK2W9K6e1ebNro3WT7u5yGX.jpg",20196],["The King of Idiots",2006,1.5,1,"Boris Quercia","Comedy","uXi94u08fyKQTQvgJWsZ3MrcUf6.jpg",20221],["Sex with Love",2003,2.5,1,"Boris Quercia","Comedy, Romance","9Unz4SnlkXg0OAxgiLKZAfu096c.jpg",20222],["The Stranger",1946,3.5,1,"Orson Welles","Thriller, Crime","bzjoPScBLUWpSu10m3GbSbSwVhS.jpg",20246],["Swing Time",1936,3.5,1,"George Stevens","Romance, Comedy","yjoduUg87Tz1EPn7cTVKAa34uBG.jpg",20325],["The Shop Around the Corner",1940,3.5,1,"Ernst Lubitsch","Comedy, Drama, Romance","dZ1aEzGYRiqJwPfjS6VL7wUkHmF.jpg",20334],["The Bird with the Crystal Plumage",1970,3.5,1,"Dario Argento","Horror, Mystery, Thriller","dpALRkwodEIT7TGX9SqTgwVNn0i.jpg",20345],["Despicable Me",2010,2.5,1,"Pierre Coffin & Chris Renaud","Animation, Comedy, Crime, Science Fiction, Family","b1BT309QWjtFUlJPLmXmrcHOWEL.jpg",20352],["Detour",1945,3,1,"Edgar G. Ulmer","Drama, Thriller","gJb9HRAs1V4bA0VKsWpT6mhv2RT.jpg",20367],["3 Idiots",2009,2.5,1,"Rajkumar Hirani","Drama, Comedy","66A9MqXOyVFCssoloscw79z8Tew.jpg",20453],["Crónicas",2004,2.5,1,"Sebastián Cordero","Crime, Drama, Thriller","pPQOC8eyaJmlouI9Il4dCF2iS6E.jpg",20511],["TRON: Legacy",2010,3,1,"Joseph Kosinski","Adventure, Action, Science Fiction","8Nc6R8k7bG8frSiDJo0oLucF7dN.jpg",20526],["Late Spring",1949,3.5,1,"Yasujirō Ozu","Drama","iNtRSY2AGjW1VDXDR79bKsNUdus.jpg",20530],["Sansho the Bailiff",1954,3,1,"Kenji Mizoguchi","Drama","cOBsWxFtEoqXIPx4JZP5E7g1WEo.jpg",20532],["The Pawnbroker",1964,4.5,1,"Sidney Lumet","Drama","o4CT5WPqmOLF2QfodAuGT7jQNn1.jpg",20540],["21 Up",1977,4,1,"Michael Apted","Documentary","hUpBpbicXBUEVCHOuGAyisN10V7.jpg",20553],["Let It Be",1970,3.5,1,"Michael Lindsay-Hogg","Documentary, Music","rYvoOo6h48xhDGIIaiP8XyEeVVQ.jpg",20556],["28 Up",1984,4,1,"Michael Apted","Documentary","jqwouPCwQF9UTl8GjIBjbLivmdw.jpg",20561],["35 Up",1991,3.5,1,"Michael Apted","Documentary","qiOy7FiLmYvcYDuXRUkhopsuQRF.jpg",20562],["Queen: Live at Wembley Stadium",1986,4,1,"Gavin Taylor","Music","t4yJoAIRZGGlIjljv0qGcv8rSiU.jpg",20575],["Seconds",1966,4.5,1,"John Frankenheimer","Science Fiction, Thriller, Horror","5G3q3OvulFTnFdiouaZdD8wjtIc.jpg",20620],["Robin Hood (2010)",2010,2,1,"Ridley Scott","Action, Adventure, History, Drama","kE4Wie1VVRGQbVSIsEnxmly3FqZ.jpg",20662],["Rugrats Go Wild",2003,1.5,1,"Norton Virgien","Family, Comedy, Adventure, Animation, Fantasy","hpVpXRNY2IsU0xvfXtYOxu0QDwc.jpg",20694],["La Maison en Petits Cubes",2008,4,1,"Kunio Kato","Animation, Drama","kNGiHnbAToF1iIkN2kOTCEEXtAc.jpg",20722],["Lilo & Stitch 2: Stitch Has a Glitch",2005,2,1,"Tony Leondis","Animation, Family, Comedy, Science Fiction","p2R4mhZcikWEBlqv80VfJ7M9xql.jpg",20760],["But I'm a Cheerleader",1999,4,2,"Jamie Babbit","Comedy, Drama, Romance","dGEwlAuzTZoZjvsqgT2MRKHnGi8.jpg",20770],["The Man Who Saved the World",1982,1,1,"Çetin İnanç","Science Fiction, Action, Adventure, Fantasy","osC4REvPVBBGca3sleO7pANbSVC.jpg",20787],["Aliens in the Attic",2009,1,1,"John Schultz","Adventure, Comedy, Family, Fantasy, Science Fiction","bb8ym5zSRGmhNx3gyDnzSN2waS4.jpg",20856],["Welcome, or No Trespassing",1964,4,1,"Elem Klimov","Comedy, Family","9QijJUlaeuNpuePp8nkQt24sGSb.jpg",20886],["Cutie Honey",2004,3,1,"Hideaki Anno","Action","6WoyOCZUuCovSO6Q4nj1C4cmNyz.jpg",20921],["Innocent Voices",2004,3,1,"Luis Mandoki","Drama, War","hvwB4LdMCLzqXsk5ZjR77vzPkGk.jpg",20941],["The Ugly Truth",2009,2,1,"Robert Luketic","Comedy, Romance","2rq96Ihbqb1eU3TEBVtgFlqbeX7.jpg",20943],["Balto",1995,2.5,1,"Simon Wells","Adventure, Animation, Drama, Family","dCVcdb5oxDizqFLz0F7TE60NoC9.jpg",21032],["Ocean Waves",1993,3,1,"Tomomi Mochizuki","Animation, Drama, Romance, TV Movie","fSR1LLMIJZ6WcQEkM82yKy4F9vQ.jpg",21057],["Harvie Krumpet",2003,4,1,"Adam Elliot","Animation, Comedy, Drama","5TWvqqncvw5azIwnSGl8i9xTFZr.jpg",21131],["L'Eclisse",1962,3,1,"Michelangelo Antonioni","Drama, Romance","oXoe0Fp92Yw3mMJ9Vq0hPlaMELg.jpg",21135],["Lost in La Mancha",2002,4,1,"Keith Fulton & Louis Pepe","Documentary","gPlWNmQOzJ7j8djCxXcc40syVS3.jpg",21189],["Orphan",2009,3,1,"Jaume Collet-Serra","Horror, Thriller","lCGpOgoTOGLtZnBiGY9HRg5Xnjd.jpg",21208],["Children of Heaven",1997,4.5,1,"Majid Majidi","Drama, Family","jWqh1CJWAEcxckMRrf6ARhIEh0R.jpg",21334],["Naked",1993,4.5,1,"Mike Leigh","Drama, Comedy","xMYP4uaNeyPmX4FQ2xxWk2eIN6K.jpg",21450],["Possession",1981,5,1,"Andrzej Żuławski","Horror","lUFZsUuJ0YyhBXH8D2BFUd6wODm.jpg",21484],["I Live in Fear",1955,2.5,1,"Akira Kurosawa","Drama","lStaAPLPkPc5NkeHzZoi191efOy.jpg",21490],["Noroi: The Curse",2005,3.5,1,"Koji Shiraishi","Horror, Mystery, Thriller","yjXTmyLaOqljI5pFNbrEZ213dSW.jpg",21506],["Project A",1983,3,1,"Jackie Chan","Action, Adventure, Comedy","AvTu2bmJbVZGXPxdx6VllGXCtLG.jpg",21519],["Barking Dogs Never Bite",2000,3.5,1,"Bong Joon Ho","Comedy, Crime, Drama","6jTxgTN3rS2p1DH36IsBsVpdF5e.jpg",21531],["A Prophet",2009,3,1,"Jacques Audiard","Crime, Drama","x9Jb8kewBHPzjTtgCQvoQoDsy4d.jpg",21575],["The Damned United",2009,3.5,1,"Tom Hooper","Drama, History","ftlbCma6QoRiZgiflVmLuPKHrkq.jpg",21641],["Mind Game",2004,4.5,1,"Masaaki Yuasa","Animation, Romance, Comedy, Drama, Fantasy, Adventure","e5mV1iVcjg7nkpJrskQOnFCR4H9.jpg",21712],["Shadow of a Doubt",1943,4.5,1,"Alfred Hitchcock","Thriller, Mystery, Crime","ptyWagbWE8jSGyV2tGEzAdVbRCj.jpg",21734],["The Brothers Bloom",2008,3,1,"Rian Johnson","Adventure, Comedy, Drama, Romance","xIz8iwzyjgWGzcIwHKpqhBs77ML.jpg",21755],["Neon Genesis Evangelion: Death and Rebirth",1997,3.5,1,"Hideaki Anno","Animation, Drama, Science Fiction","lXBjqzo6c4NyLuJtqOiH39kswji.jpg",21832],["A Face in the Crowd",1957,3.5,1,"Elia Kazan","Drama","2dkl9CDynHbIHDkIiPzKPFqnwFy.jpg",21849],["The Deep",2010,3,1,"PES","Comedy, Romance","obMNcO8izVF6Zv7crsmwvsDeyK9.jpg",21862],["Booty Call",1997,1.5,1,"Jeff Pollack","Comedy","1pQpHVm3AXIwbBUnwGEQ0q95E0L.jpg",21915],["Super Fly",1972,3.5,1,"Gordon Parks Jr.","Crime, Drama, Action, Thriller","lCj4IZ9l8NfOEiM4zHq3BRF2LzX.jpg",21968],["Polytechnique",2009,4,1,"Denis Villeneuve","Crime, Drama, Thriller","k0xmtct9cSseksuFKMSXxM8hfni.jpg",22302],["Baby Geniuses",1999,0.5,1,"Bob Clark","Science Fiction, Comedy, Family","7zvPhjHkz5YEMUMPyvANCR96RJA.jpg",22345],["Postcards from the Edge",1990,3,1,"Mike Nichols","Comedy, Drama","uF7bO5UcenRgag0jpbVvKsGyfBK.jpg",22414],["Guilty by Suspicion",1991,2.5,1,"Irwin Winkler","Drama, Thriller","fUpxydE70PNWr7Tu5WpefNnTv2i.jpg",22423],["The Wrong Man",1956,3.5,1,"Alfred Hitchcock","Crime, Drama","pO5XR2R56RAbVjdks9gGGn0fbOa.jpg",22527],["Thirst",2009,4,1,"Park Chan-wook","Drama, Horror, Thriller","sFgvkGpXLTydvHqBCXw54OB8R0h.jpg",22536],["Scott Pilgrim vs. the World",2010,4,2,"Edgar Wright","Action, Comedy, Romance","g5IoYeudx9XBEfwNL0fHvSckLBz.jpg",22538],["Tom and Jerry: The Movie",1993,1,1,"Phil Roman","Animation, Comedy, Family","k68ZB5trRKcEJSQdPiY6jtxVq14.jpg",22582],["The Swan Princess",1994,2,1,"Richard Rich","Family, Animation, Fantasy, Adventure, Comedy","f5YvIPrkJ9HCsNbgzWJJyxXVNhj.jpg",22586],["Safety Last!",1923,3.5,1,"Sam Taylor","Comedy, Romance, Thriller","fEt5HWJ32ek8ibef7zSZnA00Jp0.jpg",22596],["Mickey's House of Villains",2002,2.5,1,"MANY","Family, Animation, Comedy, Fantasy","82qQAp7rcAwVnW12xbkVImp0unP.jpg",22643],["The Beast of Yucca Flats",1961,0.5,1,"Coleman Francis","Horror, Science Fiction","EK8aMR79yM1JnaXbbwKSIeACV9.jpg",22727],["Boxcar Bertha",1972,3,1,"Martin Scorsese","Crime, Drama","gF5VslUB2xpWbboc735VVnO7DXh.jpg",22784],["Cloudy with a Chance of Meatballs",2009,3,1,"Phil Lord & Christopher Miller","Animation, Comedy, Family","qhOhIKf7QEyQ5dMrRUqs5eTX1Oq.jpg",22794],["Whip It",2009,2.5,1,"Drew Barrymore","Drama","iRUviw0Dxs0FZI1IcSDYFX02i8s.jpg",22798],["Saw VI",2009,2,1,"Kevin Greutert","Horror, Thriller","9JtluosCbioSXJSABZByaODyPpa.jpg",22804],["Evangelion: 2.0 You Can (Not) Advance",2009,3.5,2,"Hideaki Anno","Animation, Science Fiction, Action, Drama","7VLYN2CfJpB6PrcuzDKKqdGSUi6.jpg",22843],["The Blind Side",2009,2,1,"John Lee Hancock","Drama","bMgq7VBriuBFknXEe9E9pVBYGZq.jpg",22881],["Up in the Air",2009,4,1,"Jason Reitman","Drama, Romance","useGH8nfwlaHK44IWEZdUYJOE2N.jpg",22947],["The Cabin in the Woods",2011,4,1,"Drew Goddard","Horror, Mystery, Comedy","zZZe5wn0udlhMtdlDjN4NB72R6e.jpg",22970],["The Prowler",1951,3,1,"Joseph Losey","Drama, Thriller","7i5jflxPAWYRz0cxgmabiCYfXDe.jpg",22985],["Tooth Fairy",2010,1,1,"Michael Lembeck","Comedy, Family, Fantasy","cRZvw3bPomtucIUtMHZ3qPIYtYs.jpg",23023],["Benji",1974,2.5,1,"Joe Camp","Adventure, Family, Romance","aSowNmq4bZrmfazhQBePyNF8A2E.jpg",23069],["The Invention of Lying",2009,2.5,1,"Ricky Gervais","Comedy, Fantasy, Romance","clP8tDZeM9jgnqmu4VBClBDpLtS.jpg",23082],["The Town",2010,3.5,1,"Ben Affleck","Crime, Drama, Thriller","3NIzyXkfylsjflRKSz8Fts3lXzm.jpg",23168],["Remember Me",2010,2,1,"Allen Coulter","Drama, Romance","j7umuMiLCHvWT7wYhFKJOTFSokF.jpg",23169],["The Spy Next Door",2010,2,1,"Brian Levant","Action, Comedy, Family","nJJrceb2xHGIA0irADX0JvWSIHT.jpg",23172],["Trick 'r Treat",2007,3,1,"Michael Dougherty","Horror, Fantasy, Comedy","w0nmol4g7n6MFfhfphV7GzHHYjB.jpg",23202],["One Week",1920,4.5,1,"Buster Keaton","Comedy","43KTefZOLOaXw4Rbywn3uu8BiJn.jpg",23282],["Alvin and the Chipmunks: The Squeakquel",2009,0.5,1,"Betty Thomas","Comedy, Family, Animation, Fantasy, Music","op4mzd0zzIBQN6UGW4KlSREMfPq.jpg",23398],["House of Usher",1960,3.5,1,"Roger Corman","Horror, Drama","jEzZOrGSWpl0jKOIXoY3OnEabLQ.jpg",23439],["Kick-Ass",2010,3.5,1,"Matthew Vaughn","Action, Crime","iHMbrTHJwocsNvo5murCBw0CwTo.jpg",23483],["Sucker Punch",2011,1,1,"Zack Snyder","Action, Fantasy, Thriller","jtaUDnvIiHUd2ranDcjB5AbPx6o.jpg",23629],["Machete (2010)",2010,3,1,"Robert Rodriguez","Action, Comedy, Thriller","dcPSm1rGEFdiEc7DaKz0t5kb66b.jpg",23631],["Machete",2007,3.5,1,"Robert Rodriguez","Action, Comedy, Thriller","dcPSm1rGEFdiEc7DaKz0t5kb66b.jpg",23631],["Ten Minutes Older: The Trumpet",2002,2,1,"MANY","Drama, Documentary","yxIKQ2MeZAYiZ5lbJyYrNmXf7Dy.jpg",23676],["C.H.U.D.",1984,2.5,1,"Douglas Cheek","Horror, Science Fiction","8BVw5RIDBTZwdMAR1VKpAkwrMjj.jpg",23730],["Paranormal Activity",2007,1.5,1,"Oren Peli","Horror, Mystery","tmclkEpjeo4Zu564gf3KrwIOuKw.jpg",23827],["The Twilight Saga: Eclipse",2010,1,1,"David Slade","Adventure, Fantasy, Drama, Romance","dK4Gi1UdMiHzHc7r7CZQG4IQ9Sr.jpg",24021],["976-EVIL",1988,2.5,1,"Robert Englund","Horror","qQVLe0h2k06aamoAI5KjOle7mJR.jpg",24038],["The Tournament",2009,1.5,1,"Scott Mann","Horror, Action, Thriller","zVkPQAIoCNDc8khNjmSAiTb3lV5.jpg",24056],["The Black Cat",1934,2.5,1,"Edgar G. Ulmer","Horror, Thriller","QTH3dkeDGTBRBmsY0A7STpsNN4.jpg",24106],["Stop Making Sense",1984,5,11,"Jonathan Demme","Documentary, Music","utNpurUe1MMjEaHqvpkfxgfpSnV.jpg",24128],["Halloween II (2009)",2009,2,1,"Rob Zombie","Horror","vSHPM4LQDpWdQrD5KZWK6wNqSOD.jpg",24150],["Il Sorpasso",1962,2.5,1,"Dino Risi","Drama, Comedy, Adventure","4h1ckrJQVcQYjeOkqS8i9BqZ9MI.jpg",24188],["The Verdict",1982,4,1,"Sidney Lumet","Drama","m3DdNJZfBcsTiFe0SwsLChWavrG.jpg",24226],["Mary and Max",2009,4.5,1,"Adam Elliot","Animation, Comedy, Drama","ebmsM382m9IClLUzKYY2U5biFwM.jpg",24238],["Tokyo Mater",2008,2,1,"John Lasseter","Animation, Comedy, Family, Action, Adventure","sGwVl4R4RD2rV8NHWthpjemA1zU.jpg",24328],["Final Flight of the Osiris",2003,2.5,1,"Andrew R. Jones","Science Fiction, Action, Animation","mWCKgKcF47wxagChqUD2GTwfDaw.jpg",24357],["The Second Renaissance Part I",2003,4,1,"Mahiro Maeda","Science Fiction, Animation","mP8yrOPUGOWssebZePBrLxWIMY3.jpg",24358],["The Second Renaissance Part II",2003,3.5,1,"Mahiro Maeda","Science Fiction, Animation","dI6Z5vpy78ZJkdOV2qvE6IjWTjl.jpg",24362],["Big Deal on Madonna Street",1958,3.5,1,"Mario Monicelli","Comedy, Crime","f5OxD8Nl0pR3DcYHtYhHRfpsmjl.jpg",24382],["The Avengers",2012,3.5,2,"Joss Whedon","Science Fiction, Action, Adventure","RYMX2wcKCBAr24UyPD7xwmjaTn.jpg",24428],["The Little Shop of Horrors",1960,2.5,1,"Roger Corman","Horror, Comedy, Fantasy","s9MrumN9oCfv1rFoEvMLwucWD7V.jpg",24452],["Fish Tank",2009,4,1,"Andrea Arnold","Drama","rI3MKBDsWzQHi9PWDAMKkgmYcff.jpg",24469],["Partly Cloudy",2009,3,1,"Peter Sohn","Animation, Family, Comedy, Fantasy","oqYX2AJV53ibLVPrUZ1Z5XlGv5U.jpg",24480],["The Sacrifice",1986,3.5,1,"Andrei Tarkovsky","Drama","8JMh27z075ZHbFE85XYkdXF2QkK.jpg",24657],["A Detective Story",2003,3.5,1,"Shinichiro Watanabe","Science Fiction, Animation, Crime","8HoobMnhDvdWMaFDNYAOYqwA9Nw.jpg",24660],["An Education",2009,3.5,1,"Lone Scherfig","Drama, Romance","gLIvvUdlocGjm8XVLxhWHAKWrRq.jpg",24684],["True Stories",1986,3.5,1,"David Byrne","Comedy, Music","sngF8cskFWz2cig7b63ZaDNaQXr.jpg",24798],["Julie & Julia",2009,3,1,"Nora Ephron","Romance, Drama","1QZNWOOwfRi86ZApGvr2TtJZPBK.jpg",24803],["Black Dynamite",2009,3.5,1,"Scott Sanders","Comedy, Action","u3oWQDz0JggzzsVlsuHY7XVxp5Y.jpg",24804],["Medicine for Melancholy",2008,3,1,"Barry Jenkins","Drama, Romance","gyO8w5lpK3kwBojTulRpYcA4MAo.jpg",24885],["Kid's Story",2003,3,1,"Shinichiro Watanabe","Science Fiction, Animation","SteXNwc3hRV9o2BlyxV3yBXCV2.jpg",24914],["Matriculated",2003,3,1,"Peter Chung","Animation, Drama, Science Fiction","eEeLrXcepU08IF1I418AWXswNbl.jpg",24950],["Program",2003,3,1,"Yoshiaki Kawajiri","Science Fiction, Animation","5Ct5NLNwfkT3CaFBTAbaomtMpdI.jpg",24959],["World Record",2003,3.5,1,"Takeshi Koike","Science Fiction, Animation","1RAWp6zbxRyC4ddutyZLqwAr8Lv.jpg",24960],["The Wiz",1978,2.5,1,"Sidney Lumet","Fantasy, Family, Adventure","rgfB8hBRSwbEb0SK7pt9mW9jsyP.jpg",24961],["Gates of Heaven",1978,3.5,1,"Errol Morris","Documentary","2VGQsyCvd2XJKpKZXHF4AWsADoA.jpg",24998],["The Life and Death of Colonel Blimp",1943,4.5,1,"Michael Powell & Emeric Pressburger","War, Drama, Romance, Comedy","kgyd5uyndsXiLYKlVgH0sm7Jfkv.jpg",25037],["Still Walking",2008,4.5,1,"Hirokazu Kore-eda","Drama, Family","4Are9oV8HjZQWnEajk9LYFxRWom.jpg",25050],["Fast, Cheap & Out of Control",1997,4.5,1,"Errol Morris","Documentary","8uXV6w3ZQUtefqjCgxXswCwPSjk.jpg",25099],["Six Shooter",2004,3.5,1,"Martin McDonagh","Drama, Comedy, Crime","hBJTJi0SH4avrBr7OQqBZuYPvmA.jpg",25126],["The Banishment",2007,3,1,"Andrey Zvyagintsev","Drama","hD5Dg3VztZbvk2aqQsHh1e5jUP4.jpg",25142],["Bye Bye Birdie",1963,2,1,"George Sidney","Comedy, Music","u3m2kU5aFj6V6cNYOd9a22Iia7O.jpg",25167],["The Last Picture Show",1971,4.5,1,"Peter Bogdanovich","Drama, Romance","7NYePZc0lZrRomtmQsjOJMePTEb.jpg",25188],["Leap Year",2010,1.5,1,"Anand Tucker","Romance, Comedy","i86hMi5iEF3WnYLCaGHdT5FPdYg.jpg",25195],["Come and See",1985,4.5,1,"Elem Klimov","Drama, War","qNbMsKVzigERgJUbwf8pKyZogpb.jpg",25237],["The Masque of the Red Death",1964,3.5,1,"Roger Corman","Drama, Horror","sSYceyGZrWskWDsn3MHtipJ1wFM.jpg",25319],["Muse: HAARP - Live from Wembley Stadium",2008,3.5,1,"Tom Kirk","Music, Documentary","2wEf9UnQWjoicYaodUlaILRy9Fe.jpg",25352],["Irma Vep",1996,3,1,"Olivier Assayas","Comedy, Drama","9Z84G7mn8eS7WxiHr5CrXRrneaF.jpg",25355],["Ace in the Hole",1951,4,1,"Billy Wilder","Drama","gPVPzHEsJBX02HtBtIQgYnfeqNQ.jpg",25364],["The Secret in Their Eyes",2009,5,3,"Juan José Campanella","Mystery, Thriller, Drama","dkeAwfZzwL3WvToydE3CXiY80E0.jpg",25376],["Matinee",1993,3.5,1,"Joe Dante","Comedy, Drama","5Hkt61mL0yixpC6ML24R8gDdh8y.jpg",25389],["My Dinner with Andre",1981,3.5,1,"Louis Malle","Drama, Comedy","u2KB70Xlzwg920mYWlGb18YIatd.jpg",25468],["Cat People",1942,3.5,1,"Jacques Tourneur","Mystery, Horror, Romance","zSNTDd5Q6No5BmY39Zp5BVgl8XE.jpg",25508],["Yi Yi",2000,5,1,"Edward Yang","Drama","mR8dSQZI8X6Z1NClJhFrtJp636z.jpg",25538],["House",1977,3,2,"Nobuhiko Obayashi","Comedy, Fantasy, Horror","tXlEgAJkGQuE9Vm6ppYERUBmdDM.jpg",25623],["Foreign Correspondent",1940,2.5,1,"Alfred Hitchcock","Thriller, Mystery, Action","n0WX6eIdIliKB66MI2MWZ3wHsoJ.jpg",25670],["Post Grad",2009,1.5,1,"Vicky Jenson","Comedy, Drama, Romance","yM1QcAtEGkzAM3HFznXj8kvjyDk.jpg",25704],["Steamboat Bill, Jr.",1928,3,1,"Buster Keaton","Comedy, Romance","zygJMsmXxeyDc1N67OCZc8xtq4I.jpg",25768],["Pink Floyd: Live at Pompeii",1972,4.5,2,"Adrian Maben","Music, Documentary","bxjgbHH14nEMx3YtFDLJ04omQhH.jpg",25771],["Balto: Wolf Quest",2002,2,1,"Phil Weinstein","Family, Animation, Adventure","dZ958HnW3JO2pEZeedjmoZCV8Rn.jpg",25913],["I Married a Witch",1942,3.5,1,"René Clair","Romance, Fantasy, Comedy","pOtHcQfo0wCesRfeDPacrS2bD3W.jpg",25970],["American Pie Presents: The Book of Love",2009,1,1,"John Putch","Comedy","hwP0GEP0zy8ar965Xaht19SmMd3.jpg",26123],["George of the Jungle 2",2003,1,1,"David Grossman","Adventure, Comedy, Family","hMJbCWC9EpkVNKM3KaIOElCQIrT.jpg",26264],["I Killed My Mother",2009,4,1,"Xavier Dolan","Drama","nB6OuDdERS95aQtoxPExXxsW3Ov.jpg",26280],["Man with a Movie Camera",1929,4.5,1,"Dziga Vertov","Documentary","vJgAdgJWX54v0oXfIvhwjlZnmgn.jpg",26317],["The Last of Sheila",1973,3.5,1,"Herbert Ross","Crime, Drama, Mystery, Thriller","oTwaBz4wByO8qcYqWaBuRLeCTC8.jpg",26331],["Shame (1968)",1968,3.5,1,"Ingmar Bergman","War, Drama","cRJFOadujA7COrBV4HqB6bWcpLs.jpg",26372],["From Paris with Love",2010,2,1,"Pierre Morel","Action, Crime, Thriller","poVoLKLxUqsTLSntA40Po2F78dZ.jpg",26389],["Agora",2009,3.5,1,"Alejandro Amenábar","Adventure, Drama, History","1xsFa6I5vDd2UI1AJ1tsW7BUChv.jpg",26428],["Martin",1977,4,1,"George A. Romero","Horror, Drama","2UaQChRF3leBWlxYgVnUim7Conj.jpg",26517],["Old Joy",2006,3.5,1,"Kelly Reichardt","Drama","AdFKZOf0LtPpGq8be9T8qsNHTbs.jpg",26518],["Crumb",1994,4,1,"Terry Zwigoff","Documentary","9ocTHdBCJdwJ65Tubg3lYlfMxEY.jpg",26564],["Johnny Guitar",1954,4,1,"Nicholas Ray","Western","bap37yOCwcR9x4YDsNUaSo9nIp9.jpg",26596],["Performance",1970,3,1,"Nicolas Roeg","Crime, Drama","yKuqk84TtTpj0nYZS5m680JmprG.jpg",26606],["Five Easy Pieces",1970,4,1,"Bob Rafelson","Drama","xGLkuMWigSPLBvWiENSMlVq56iE.jpg",26617],["The Thief and the Cobbler",1993,3.5,1,"Richard Williams","Animation, Family, Fantasy, Romance","3OKtFuTxahr7hokPB9aO38qgOfc.jpg",26672],["House of Games",1987,4,1,"David Mamet","Crime, Thriller, Drama","4i27Ut4cIoLbcNpW7aeuUQErEPE.jpg",26719],["Wizards of Waverly Place: The Movie",2009,1.5,1,"Lev L. Spiro","Family, TV Movie, Adventure, Comedy, Fantasy, Action, Drama","vrjLcGBLurVem5lXN8237qz4tyE.jpg",26736],["Rage",2009,1.5,1,"Sally Potter","Thriller, Drama","atqccoctqnvjj9yepJMxytbRvqf.jpg",26738],["Star",2001,2,1,"John Sayles","Drama, Mystery, Western","lBxY8znsRoqa9Dy2NCe8I6GPsRm.jpg",26748],["Shadows of Forgotten Ancestors",1965,2.5,1,"Sergei Parajanov","Drama, Romance","9oSZTeejmx80tIBVSqYzJpFhjkI.jpg",26782],["Shrek in the Swamp Karaoke Dance Party",2001,1.5,1,"Vicky Jenson","Animation, Comedy, Music, Family, Romance","lJg4alrYfp7CDNVID4iGefT9CIn.jpg",26840],["The Brother from Another Planet",1984,3,1,"John Sayles","Comedy, Science Fiction, Drama","woSsOJmx8lBD14wA4Jlmf4DrJXc.jpg",26889],["Oasis",2002,4,1,"Lee Chang-dong","Drama, Romance","aaajiBpeBVbVwovpSQKaMfKRGKw.jpg",26955],["The Secret of Kells",2009,4,1,"Tomm Moore","Animation, Family, Fantasy","vBymyj7QsXiW4TICD2JC5pAuBHO.jpg",26963],["Céline and Julie Go Boating",1974,2.5,1,"Jacques Rivette","Comedy, Drama, Fantasy","h62tGTMdVVUThFwl5b4EP18cBhb.jpg",27019],["The Sorcerer's Apprentice",2010,1,1,"Jon Turteltaub","Fantasy, Adventure, Action","b5pIUsGll0418NyfNA5eYCI9aoK.jpg",27022],["Meshes of the Afternoon",1943,4.5,1,"Maya Deren","Mystery, Fantasy","pRLqidsUdxYM5pXLJ9mqm2n9U9K.jpg",27040],["Mishima: A Life in Four Chapters",1985,4.5,1,"Paul Schrader","Drama","4kIXsE4SwUjO0eUqpolsHNO5GLH.jpg",27064],["On the Silver Globe",1988,2.5,1,"Andrzej Żuławski","Science Fiction, Drama","4zzam82e6rCY2Ktm0fyRoseHhkh.jpg",27072],["Lenny",1974,4,1,"Bob Fosse","Drama","Avhk4pGdz3YQrzqLU65icjnE6vn.jpg",27094],["The Attic",2006,1,1,"Mary Lambert","Horror, Thriller","lFUtefvTdSTlxaEQBcKh0AQ2Lwt.jpg",27122],["I Walked with a Zombie",1943,2.5,1,"Jacques Tourneur","Fantasy, Drama, Horror, Mystery","uoyBR8XNxPQRojujtczfG1qJezY.jpg",27130],["Inception",2010,4.5,2,"Christopher Nolan","Action, Science Fiction, Adventure","xlaY2zyzMfkhk0HSC5VUwzoZPU1.jpg",27205],["Frankenhooker",1990,3,1,"Frank Henenlotter","Comedy, Horror, Science Fiction","s8Oubzkc2pPdOdj4D23ljZSKRbg.jpg",27274],["Jack Frost",1997,2.5,1,"Michael Cooney","Fantasy, Horror, Comedy","sXOATwGluNbb9ezfG6DvXCiXvJp.jpg",27318],["Phantom of the Paradise",1974,3.5,1,"Brian De Palma","Comedy, Drama, Horror, Music","qDOtGWeSQNwB3dG7Amt1K0JW0az.jpg",27327],["Linda Linda Linda",2005,3.5,1,"Nobuhiro Yamashita","Comedy, Music, Drama","wX3xwuJ9uhCamndfGUePDkpAggZ.jpg",27337],["Innocent Blood",1992,2.5,1,"John Landis","Comedy, Horror, Crime, Action, Romance","bloBdkHtAHSAJWa31Gls59z0xfb.jpg",27381],["Shivers",1975,3,1,"David Cronenberg","Horror, Science Fiction","wcgfPA5FicDgQXaw67kjtUxuxdb.jpg",27429],["The Panic in Needle Park",1971,4,1,"Jerry Schatzberg","Drama, Romance, Crime","rhJ8Dnl6Z9KR9R2zskBKIfrFeFs.jpg",27554],["The Maid",2009,4,1,"Sebastián Silva","Drama, Comedy","1JeiuLk0xBHgc4tX0FxoZYb0OpV.jpg",27567],["The Expendables",2010,2,1,"Sylvester Stallone","Thriller, Adventure, Action","j09ZkH6R4JWVylBcDai1laCmGw7.jpg",27578],["Greenberg",2010,3,1,"Noah Baumbach","Comedy, Drama, Romance","jAsN4vPpycVxC89QlA6NYBXRuK7.jpg",27583],["Rabbit Hole",2010,3.5,1,"John Cameron Mitchell","Drama","zTUQXwMn4ndt5AAcDvJCi14ZY2B.jpg",27585],["Black Sunday",1960,3,1,"Mario Bava","Horror","x41Zx8GeZhducquhOq9nE7z1GBG.jpg",27632],["Nothing Left to Do But Cry",1984,1.5,1,"Roberto Benigni","Comedy, Fantasy","4CX5fwuwZBehGDt6PhSMr49aMT7.jpg",27670],["405",2000,0.5,1,"Jeremy Hunt","Thriller, Action, Comedy","8uXCPtXLMIlJbILK2Za7e2l2dJl.jpg",27869],["Raptor",2018,3,1,"Felipe Gálvez","Science Fiction, Action","aoetIO34uXYXwRqruH4DxGa0QGW.jpg",27896],["Little Caesar",1931,3.5,1,"Mervyn LeRoy","Drama, Crime, Action","1K3Q1tAHHA5Sdtja2pPALBQevA7.jpg",27899],["Cruising",1980,3,1,"William Friedkin","Crime, Mystery, Thriller","bb9CND0WyfwdHOZY5XmP4Qn8taz.jpg",27958],["She's Gotta Have It",1986,3.5,1,"Spike Lee","Comedy, Romance","qiJuXvPONqTSSnzhbCBqE7EotV.jpg",27995],["Maniac Cop 2",1990,2,1,"William Lustig","Action, Horror, Mystery, Thriller","NWeLUBpxn7lcMpCPvnTGmtHwmj.jpg",28090],["They Shoot Horses, Don't They?",1969,4.5,1,"Sydney Pollack","Drama","7wVLBgriOQpT5RrufAFCdCSUp7M.jpg",28145],["A Matter of Life and Death",1946,4,1,"Michael Powell & Emeric Pressburger","Romance, Fantasy, Drama, Comedy","H74LWKnhOeIFSk9gNjBcPjIov3.jpg",28162],["Tucker: The Man and His Dream",1988,2.5,1,"Francis Ford Coppola","Drama","uph7wz8WASLHwHyC5SYfQgqaoV7.jpg",28176],["Hachi: A Dog's Tale",2009,2,1,"Lasse Hallström","Drama, Family","lsy3aEsEfYIHdLRk4dontZ4s85h.jpg",28178],["Concert for George",2003,4,1,"David Leland","Music, Documentary","mpz7cVFuwC9QnNMb2SjZOqzCJUx.jpg",28236],["The Gay Divorcee",1934,3,1,"Mark Sandrich","Comedy, Romance","xD6oUOAa0Q6PppaOnY6dy6sWPLG.jpg",28288],["Kicking and Screaming",1995,2.5,1,"Noah Baumbach","Comedy, Drama, Romance","ynAtSpTou7snNOq32djzILw9VCA.jpg",28387],["Love Exposure",2008,5,1,"Sion Sono","Comedy, Drama, Romance","3QSGUdzG374H7pOxIdKNBpeLEUk.jpg",28422],["Stolz der Nation",2009,2.5,1,"Eli Roth","War, Action, Drama","iPatk3OM3bZk69jvTEB9JoC10b1.jpg",28447],["The Lost Weekend",1945,3.5,1,"Billy Wilder","Drama","8ggIOoCzt8xT2ePl8DdlRtXgcOh.jpg",28580],["Tormented",1960,1.5,1,"Bert I. Gordon","Thriller, Horror","8sGHAZVgizrAO2ixNliGVLDgZwg.jpg",28586],["The Milk of Sorrow",2009,4,1,"Claudia Llosa","Drama","bdg1wZ76HSVEtEKh7FUXYGqW9nW.jpg",28644],["The Wild One",1953,3,1,"László Benedek","Drama, Crime, Romance","ne8nuvqjczy4xPMMpYwNLuSp0ka.jpg",28696],["Summer Wars",2009,3,1,"Mamoru Hosoda","Animation, Science Fiction","yHy8TrRLnuBZ4t2C0l0pSpRXVHO.jpg",28874],["Chopping Mall",1986,2.5,1,"Jim Wynorski","Horror, Science Fiction","ggHbJPYJsjiJnEwHi4xUyJxWpmS.jpg",28941],["The Brood",1979,3.5,1,"David Cronenberg","Horror, Science Fiction","zSEt4QXRI4Gypd9xvzvucOmPNl5.jpg",28942],["Poison for the Fairies",1986,3.5,1,"Carlos Enrique Taboada","Fantasy, Horror","5kYZzOWDpnWtR6Z3h3MY5kf268o.jpg",28968],["Limelight",1952,4,1,"Charlie Chaplin","Romance, Drama, Music, Comedy","tDD11x3ZWCXXXwdpbGEU9uU4kh1.jpg",28971],["A King in New York",1957,2.5,1,"Charlie Chaplin","Comedy, Drama","e6KtBoiXa5D3LLZtiMCkiqIDnZv.jpg",28973],["A Woman of Paris: A Drama of Fate",1923,3.5,1,"Charlie Chaplin","Drama, Romance","shmnpKWwfgNzntaDLPO0WYli5PX.jpg",28974],["The Circus",1928,4,1,"Charlie Chaplin","Comedy, Romance, Drama","hWw9HfQmd4Rn1Et4vgZQsEf5tEZ.jpg",28978],["Phenomena",1985,3,1,"Dario Argento","Horror, Thriller","dhk14s8ogQkbf6re3HLKV2UBHjx.jpg",29161],["Le Trou",1960,4,1,"Jacques Becker","Drama, Thriller, Crime","xyZhiOz5NHVBUKlpioxjwajy7pm.jpg",29259],["The Exterminating Angel",1962,4.5,1,"Luis Buñuel","Comedy, Drama, Fantasy","qqZXHvBFxUpo8Pfbyvgh4SYMiWm.jpg",29264],["Destiny",1921,2.5,1,"Fritz Lang","Drama, Fantasy, Thriller","zgRB2MhCTfOMkxRO7seX6GxOaKJ.jpg",29267],["The Band Wagon",1953,2.5,1,"Vincente Minnelli","Music, Comedy, Romance","5CvUmTWK46rShfgLmw7LuKF2fYL.jpg",29376],["The Face of Another",1966,3.5,1,"Hiroshi Teshigahara","Drama, Science Fiction","eUnFdf1Mf1b8AD3ChMPOCUfTBDQ.jpg",29452],["The Magician",1958,4,1,"Ingmar Bergman","Drama","46DEYkr96MxzUmdwgmj2U7gWokZ.jpg",29453],["Winter Light",1963,4,1,"Ingmar Bergman","Drama","wDxrEssdjFWYwIZLbr06RQNcg1q.jpg",29455],["Ratcatcher",1999,5,1,"Lynne Ramsay","Drama","lNLJZTxEtoDN73GF9lq3FQ1E23y.jpg",29698],["A Woman Under the Influence",1974,4.5,1,"John Cassavetes","Drama, Romance","6EJ4JoTxnH1QmGTE9pPzgtW1cLW.jpg",29845],["Close-Up",1990,5,1,"Abbas Kiarostami","Crime, Drama","m9HG2N9ZKCmNN9qOHJTNyy18wn3.jpg",30017],["Mother",2009,4.5,2,"Bong Joon Ho","Crime, Drama, Mystery","8oBnSkZE6GDVugAbLPO6uJd4GcS.jpg",30018],["Taste of Cherry",1997,4.5,1,"Abbas Kiarostami","Drama","u6GYH4HyR0BVwpqFuTOc2g4KB1L.jpg",30020],["Chosen",2001,2.5,1,"Ang Lee","Action","62FYfcDwWJIVvsCaUr0kvAF6GRq.jpg",30091],["Vernon, Florida",1981,3,1,"Errol Morris","Documentary","dqcUISuve7pUcGT75Kwa0E8Sz6H.jpg",30142],["Stuart Little 3: Call of the Wild",2005,1,1,"Audu Paden","Animation, Comedy, Family, TV Movie","zImw7IVg8dxPkqMfT0L33sdsIHC.jpg",30178],["The Producers",1967,4,1,"Mel Brooks","Comedy","9qCIkNWGuRj5lMyeOXwJs8z9nRz.jpg",30197],["Stray Dog",1949,3.5,1,"Akira Kurosawa","Crime, Drama, Thriller, Mystery","riBzUgeYawBDi2q9PjARjHrQM7Z.jpg",30368],["The Texas Chain Saw Massacre",1974,4,1,"Tobe Hooper","Horror","mpgkRPH1GNkMCgdPk2OMyHzAks7.jpg",30497],["Blacula",1972,3,1,"William Crain","Horror, Fantasy","yLqtFeZfRPoUUzzro3ogCdobB6q.jpg",30566],["Monsieur Verdoux",1947,3.5,1,"Charlie Chaplin","Comedy, Crime, Drama","mUPXIinTQsBdLlDaWiSl7GwQXVs.jpg",30588],["Star 80",1983,3.5,1,"Bob Fosse","Drama","b2SkA02fXbZYnV1qjOIQprjXloF.jpg",30707],["Radio Days",1987,3.5,1,"Woody Allen","Comedy, Drama","ljZ3yyYznAiq1vF6nHITdJn6qXB.jpg",30890],["Kwaidan",1964,4,1,"Masaki Kobayashi","Horror, Fantasy, Drama","t9UMfViYl47SdZZatKQ1JKjjCgs.jpg",30959],["Code Unknown",2000,3.5,1,"Michael Haneke","Drama","kJJx2FNmiaep8WT21uMPY9qPzxL.jpg",30970],["Ticker",2002,2.5,1,"Albert Pyun","Action, Adventure, Crime, Thriller","qHuAAGikw2bTaam7K5B8btwUECM.jpg",31002],["Mr. Nobody",2009,4,1,"Jaco Van Dormael","Science Fiction, Drama, Romance","qNkIONc4Rgmzo23ph7qWp9QfVnW.jpg",31011],["A Short Film About Love",1988,3.5,1,"Krzysztof Kieślowski","Drama, Romance","kLAMz50Or2So1aEzHYv0R8iXo46.jpg",31056],["Shampoo",1975,2.5,1,"Hal Ashby","Comedy, Drama","6jmFvXPV6OhtX3AkAVnH7rwdeUJ.jpg",31121],["Ben & Arthur",2002,0.5,1,"Sam Mraovich","Drama, Romance, Thriller","6fVVmRBM7baWubsETorSwHChveV.jpg",31130],["Alma",2009,1.5,1,"Rodrigo Blaas","Animation, Fantasy, Horror, Mystery","A8U0i89nFG44qbFOGNMR4qeqKFy.jpg",31160],["The Human Condition I: No Greater Love",1959,4,1,"Masaki Kobayashi","War, Drama, History","q7godavx5XEbeVxEeqi4pmiOKdI.jpg",31217],["Paris Is Burning",1990,4.5,1,"Jennie Livingston","Documentary","90rCWH41mj9hjHUEy2SOHfuAOl3.jpg",31225],["The Cameraman",1928,3.5,1,"Buster Keaton","Comedy, Romance, Drama","oz7dVRzxN95IIpa7hsG5XS3nO2L.jpg",31411],["The Wind",1928,4.5,1,"Victor Sjöström","Drama, Western, Romance, Thriller","11ySoycM3ARm66RLiYE9yRcrg5b.jpg",31416],["Eyes Without a Face",1960,3,1,"Georges Franju","Drama, Horror, Thriller","8y7Z9Gvcq52uOlJlUWyn2epGGRd.jpg",31417],["To Live",1994,3.5,1,"Zhang Yimou","Drama, Romance, War","bv0qREWTw8TPAtgt22ELp1UlKVl.jpg",31439],["Ivan's Childhood",1962,4,1,"Andrei Tarkovsky","Drama, War","vmRWSLP1DE9WTta0hfzIafJ0dID.jpg",31442],["Gold Diggers of 1933",1933,3,1,"Mervyn LeRoy","Comedy, Drama","sXsUJsW9fcVT15hfBu9LyU22qmG.jpg",31511],["On the Town",1949,2.5,1,"Stanley Donen","Comedy, Romance","lEU8QQmIayAtPZrCDf2czQgTjQ1.jpg",31516],["A Woman Is a Woman",1961,3.5,1,"Jean-Luc Godard","Comedy, Drama, Romance","xrZu21hriGJQY3qY8nifh2smVHu.jpg",31522],["Scarecrow",1973,3.5,1,"Jerry Schatzberg","Drama","jK0e8jLl0pp59yX6AYMyyJPnMVJ.jpg",31587],["The Bad Sleep Well",1960,3,1,"Akira Kurosawa","Crime, Drama, Thriller","z0LhZ121uaqa31RUeu1mOnaFb5w.jpg",31589],["The Incredible Shrinking Man",1957,4,1,"Jack Arnold","Science Fiction, Adventure, Horror","vI7IdqfvsyoQAjAzRWS2fYvUoOu.jpg",31682],["Balibo",2009,1.5,1,"Robert Connolly","Drama, Mystery, Thriller","xjb9lDIk7uf5o77MhxRaRFfEEhV.jpg",31686],["The Devils",1971,4.5,1,"Ken Russell","Drama, History, Horror","y1k7eiOFc6fzm8XeTa1kNGx6JIs.jpg",31767],["Welcome Mr. Marshall!",1953,4,1,"Luis García Berlanga","Comedy","wmtax8L6Fe95m23Phc8hEpPeSPj.jpg",31936],["Vincent",1982,3,1,"Tim Burton","Animation, Fantasy","sH8CMLnuXbQv9T61mUCPHxZotDJ.jpg",32085],["The Little Drummer Girl",2018,3.5,1,"Park Chan-wook","Thriller","5KuqrUbp4YfAWNtmtMEat8tCN19.jpg",32088],["Ju-on: The Curse",2000,3.5,1,"Takashi Shimizu","Horror, Mystery","xuLEYvlIvEsy19SYfzmG5PfFL8Y.jpg",32250],["Leisurely Pedestrians, Open Topped Buses and Hansom Cabs with Trotting Horses",1889,2,1,"William Friese-Greene","Documentary","5DiUnUv1mBuD5rkoLDiABNrOUPa.jpg",32406],["Lonesome Ghosts",1937,3,1,"Burt Gillett","Animation, Comedy, Horror","ydAWe33OKMxkwd4piuQdKDVr3qO.jpg",32428],["Forgotten Silver",1995,3,1,"Peter Jackson","Comedy, TV Movie","gSLluaJR2fxmsGOtmfSKQJ9RCly.jpg",32458],["Thoroughly Modern Millie",1967,1.5,1,"George Roy Hill","Comedy, Music, Romance","ce8rBGFR0naGsp6mKy9CNKn9iSa.jpg",32489],["The Bad and the Beautiful",1952,3,1,"Vincente Minnelli","Drama, Romance","ajAXzTiPkL7JxeCRw5lQBqrKNGx.jpg",32499],["Ah, l'Amour",1995,3,1,"Don Hertzfeldt","Animation, Comedy","nMlgukrXSh9AWr0noG0lAaKE7CR.jpg",32529],["Billy's Balloon",1998,3.5,2,"Don Hertzfeldt","Animation, Comedy, Thriller","xxI9iOL838ywA8QFduJ5hwfg8yQ.jpg",32531],["Everything Will Be OK",2006,4.5,1,"Don Hertzfeldt","Animation, Drama, Comedy","agwgqQLcNB77hkWQ7GVhtuCTwBx.jpg",32532],["Genre",1996,3,1,"Don Hertzfeldt","Animation, Comedy","A9V9IYinYRoBQ0hB9aV7A9ZkpIs.jpg",32533],["I Am So Proud of You",2008,4,1,"Don Hertzfeldt","Animation, Drama","rLOR7LHwXrbD65PeXUHhT42Vf3.jpg",32534],["Lily and Jim",1997,3.5,1,"Don Hertzfeldt","Animation, Comedy, Romance","h9b93EGicJImI324TOtO0V0mKgT.jpg",32535],["Rejected",2000,5,3,"Don Hertzfeldt","Animation, Comedy","vbci2t9eg4l7fmPzyBaa0OFiyYP.jpg",32536],["The Meaning of Life",2005,3.5,1,"Don Hertzfeldt","Animation, Science Fiction","3nFxHxYwHoiw9Y3InAdtjq6N3Tz.jpg",32539],["Monkeyshines, No. 1",1890,2.5,1,"William K.L. Dickson & William Heise","Documentary","gtPXkwZZLlq3KFiDJisalti9Nvu.jpg",32571],["Seven Chances",1925,3.5,1,"Buster Keaton","Comedy, Romance","fH9woIxzqVtyv6S711vSVlS12eA.jpg",32600],["A Place in the World",1992,3,1,"Adolfo Aristarain","Drama","fm7OklHHGq8wYHWSZsVwtfv8CLx.jpg",32635],["Safe",1995,4.5,1,"Todd Haynes","Drama","2O71QsBkbqdLqQdx2yuNpJ4pFPq.jpg",32646],["The Two Jakes",1990,2.5,1,"Jack Nicholson","Crime, Mystery, Thriller","49DSKcjPUdLjzyMpf8OIKep0cLN.jpg",32669],["The Seventh Continent",1989,4,1,"Michael Haneke","Drama","hPwtcwwmOnW7Mqr1s170LHxa74A.jpg",32761],["The Lavender Hill Mob",1951,4,1,"Charles Crichton","Comedy, Crime","u4mZyim3CwXHu0zVhXjfK8fqoN7.jpg",32961],["Dickson Greeting",1891,2,1,"William K.L. Dickson & William Heise","Documentary","as6wboEEpqJXFzGNXT0poGR7BM3.jpg",33229],["Monkeyshines, No. 2",1890,2.5,1,"William K.L. Dickson & William Heise","Documentary","a0BvlND2RlKgr4TejgPQZ4Q044I.jpg",33315],["Millennium Actress",2001,5,3,"Satoshi Kon","Animation, Drama, Romance","p44UXOFBCY5xbpCKEsWpi4filCD.jpg",33320],["Pikachu's Vacation",1998,3,1,"Kunihiko Yuyama","Animation, Family, Comedy","qOypJgyH77vHWbFLWcrFg2cc6YI.jpg",33376],["American Boy: A Profile of Steven Prince",1978,4,1,"Martin Scorsese","Documentary","jnSQhFBaJ7KlJEWYmp8WfS0FVmU.jpg",33470],["Opening Night",1977,3.5,1,"John Cassavetes","Drama","5i1331f4Q2sNHUp9X3BOwWPS2Gg.jpg",33665],["Tony Manero",2008,3.5,1,"Pablo Larraín","Drama","moNodAj8wcthRY6jqhyIz99KBvB.jpg",33774],["It's Pat",1994,0.5,1,"Adam Bernstein","Comedy","tydslMVgc6DpEvwYT0MWW9byL1a.jpg",33783],["Criminal Lovers",1999,2.5,1,"François Ozon","Horror, Thriller, Romance","pFqPlZh9S1wP1MR3RiiyWiyc50i.jpg",33828],["Magical Mystery Tour",1967,3,1,"Paul McCartney","Music, Comedy, Fantasy, TV Movie","uJSqSXCeK407l7t4zTXaYSJH0gL.jpg",34038],["Songs from the Second Floor",2000,3,1,"Roy Andersson","Drama, Comedy","xMZieoxiQ1hb5zraZlhzcvU7MGN.jpg",34070],["Rendez-vous",1985,2.5,1,"André Téchiné","Drama, Romance","rICHxS03w4peWxcdGgT8pyb9eOp.jpg",34093],["Hollywood Shuffle",1987,3.5,1,"Robert Townsend","Comedy","xidkzvrJfBeZ6wVcVOxobZruiR7.jpg",34101],["Imitation of Life",1959,4.5,1,"Douglas Sirk","Drama, Romance","xt3cUn7lsjpaGuB279A4v8zAYRn.jpg",34148],["Gertrud",1964,3,1,"Carl Theodor Dreyer","Drama, Romance","o6tiS3EaSwn4wI1DStLqDJ8OZJL.jpg",34181],["The Pervert's Guide to Cinema",2005,3.5,1,"Sophie Fiennes","Documentary","9AAxgfwAnpBmQCspuwlMITekcsW.jpg",34283],["Three Little Pigs",1933,2.5,1,"Burt Gillett","Music, Animation, Comedy, Family","fKIjJa7N58Wx2MqXZZkiyRzdL1Q.jpg",34463],["The A-Team",2010,2,1,"Joe Carnahan","Action, Comedy, Crime","bkAWEx5g5tvRPjtDQyvIZ7LRxQm.jpg",34544],["The NeverEnding Story",1984,2.5,1,"Wolfgang Petersen","Adventure, Fantasy, Family","lWJC8om086h01f0CMGR9ombdpnI.jpg",34584],["Enter the Void",2009,4,1,"Gaspar Noé","Fantasy, Drama","krKnsfvSJM1PL40tLicRhVQ6kuG.jpg",34647],["A Single Man",2009,3,1,"Tom Ford","Drama, Romance","AvqTb66bS1i1NjlPC76zvxo0taT.jpg",34653],["The Police: Certifiable",2008,3,1,"Jordan Copeland","Music","CM2vMy0sbLFh4YhOXlmNURGAov.jpg",34690],["Ziggy Stardust and the Spiders from Mars",1979,3.5,1,"D. A. Pennebaker","Music","dz4erM8bFxDjMpZmKLWKS6ryHER.jpg",34759],["Death at a Funeral (2010)",2010,1.5,1,"Neil LaBute","Comedy","oBCQYMJTqV3qLjrvZ5sTZUCBky7.jpg",34803],["Baseball Bugs",1946,3,1,"Friz Freleng","Animation, Comedy","6jc1LFe4tfqkdcldqymbjIDh7yg.jpg",34929],["Bully for Bugs",1953,3,1,"Chuck Jones","Animation, Comedy","4W34wG6uAVEkK2jLbVyGl2fTCxJ.jpg",34933],["Balto III: Wings of Change",2004,1.5,1,"Phil Weinstein","Family, Adventure, Animation","3tKVHAMFTajrSLfU6gUgdubiXBG.jpg",34942],["Sanshiro Sugata",1943,3,1,"Akira Kurosawa","Drama","vmQV7lDO8hCaU6tuKhF3b9gFs4f.jpg",35022],["The Pirate",1948,2.5,1,"Vincente Minnelli","Music, Romance, Comedy, Adventure","ltoy9asHYuLcEq78jjvZPjH6LCG.jpg",35032],["The Son (2002)",2002,3.5,1,"Jean-Pierre Dardenne & Luc Dardenne","Drama","mbAG0JOVgcOIH8LVVynw87ONgej.jpg",35172],["Bunny and the Bull",2009,2,1,"Paul King","Comedy, Romance, Drama","ercbL2Oavgu296aGwKsdFofKTTW.jpg",35395],["Starstruck",2010,1,1,"Michael Grossman","Romance, Comedy, TV Movie, Music","kuyJuNiiZvu5iNr8Dgv5y75v1uc.jpg",35558],["Roujin Z",1991,3,1,"Hiroyuki Kitakubo","Animation, Drama, Science Fiction","kpJBEfjC9l7BFhmmGPmkNB8gl6h.jpg",35648],["Maelström",2000,3.5,1,"Denis Villeneuve","Drama","knhWhSDOEPcWed5ljKcJVnXbH7.jpg",35650],["Tristana",1970,3.5,1,"Luis Buñuel","Drama","zs695dsih9HRlj0YF4rujHTRya5.jpg",35838],["Tale of Tales",1979,4.5,1,"Yuri Norstein","Animation","7gWBy9z4JrkDPSfG5VbjWbbgvxk.jpg",36079],["Cure",1997,3.5,1,"Kiyoshi Kurosawa","Crime, Horror, Mystery","yTRrqIGusJuzG5Pe3iFQTnHg1Ps.jpg",36095],["More",1998,4,1,"Mark Osborne","Animation, Science Fiction","802hVxtGoC4uIYMhM6eeXKeK17l.jpg",36107],["To Each His Own Cinema",2007,3,1,"MANY","Comedy, Drama","1bTniamnmxv8TY3AUrxddrNy9rV.jpg",36108],["Hedgehog in the Fog",1975,4,1,"Yuri Norstein","Animation, Adventure, Mystery, Family","4sMh4bpyy5zhOS7G48WOsOBIhIH.jpg",36129],["The Animation Show / Intermission in the Third Dimension / The End of the Show",2003,3,1,"Don Hertzfeldt","Animation, Comedy","K1APwCmDEK334dG8vrnnU4rlW6.jpg",36154],["Winnie-the-Pooh",1969,3.5,1,"Fyodor Khitruk","Animation, Family","jSzuXChK281KUVFAZApTDJshHrZ.jpg",36161],["A Dog's Life",1918,3,1,"Charlie Chaplin","Comedy","41vqtliesQrsJQ9iTJh5nFYQgBg.jpg",36208],["Godzilla, Mothra and King Ghidorah: Giant Monsters All-Out Attack",2001,3,1,"Shusuke Kaneko","Adventure, Horror, Science Fiction, Action, Fantasy","d3lMCQJfjCBlGFy5sWpsEaBnEPl.jpg",36243],["Diary of a Chambermaid",1964,4,1,"Luis Buñuel","Drama, Comedy","epCJe5dzAn21mQ9L1fQ2FjIF13T.jpg",36245],["Simon of the Desert",1965,4.5,1,"Luis Buñuel","Comedy, Drama, Fantasy","ysTa1FtL9DvQ90F6VGVoiOdp5NM.jpg",36265],["Casino Royale",2006,4,1,"Martin Campbell","Adventure, Action, Thriller","lMrxYKKhd4lqRzwUHAy5gcx9PSO.jpg",36557],["I Am Dina",2002,2,1,"Ole Bornedal","Drama","hXNkYhRm1JjxYNRylGwhHKqICmY.jpg",36561],["Swing Girls",2004,3.5,1,"Shinobu Yaguchi","Comedy, Music","u7lAziuBxlX4DQQzuPHDRoOwtDx.jpg",36592],["Naked Gun 33⅓: The Final Insult",1994,2.5,1,"Peter Segal","Comedy, Crime","p0AYsdgkudR9P5fNV5AjzbwQt8W.jpg",36593],["The Hairy Tooth Fairy",2006,2,1,"Juan Pablo Buscarini","Family, Animation","tcWyHT39WRYLmEN9cQtBqivm71j.jpg",36617],["The World Is Not Enough",1999,2,1,"Michael Apted","Adventure, Action, Thriller","wCb2msgoZPK01WIqry24M4xsM73.jpg",36643],["Blade",1998,1.5,1,"Stephen Norrington","Horror, Action","oWT70TvbsmQaqyphCZpsnQR7R32.jpg",36647],["X-Men: The Last Stand",2006,2,1,"Brett Ratner","Adventure, Action, Science Fiction","a2xicU8DpKtRizOHjQLC1JyCSRS.jpg",36668],["Die Another Day",2002,2.5,1,"Lee Tamahori","Adventure, Action, Thriller","bZmGqOhMhaLn8AoFMvFDct4tbrL.jpg",36669],["Never Say Never Again",1983,2,1,"Irvin Kershner","Adventure, Action, Thriller","zhoAL4o1STGgLbLxJ9r1ijfyHC9.jpg",36670],["The Rocky Horror Picture Show",1975,3,2,"Jim Sharman","Comedy, Science Fiction, Horror","3pyE6ZqDbuJi7zrNzzQzcKTWdmN.jpg",36685],["Time Bandits",1981,3.5,1,"Terry Gilliam","Family, Fantasy, Science Fiction, Adventure, Comedy","4VZtpwdhHQSa4LUkvujyGAHb1hG.jpg",36819],["Life Is Sweet",1990,4,1,"Mike Leigh","Comedy, Drama","zdkKNQzzwyciP9vAohAPFZdujlA.jpg",36843],["A New Leaf",1971,4,1,"Elaine May","Comedy, Romance","2yKcVFrizqpBBzZBEBvvBR3JKJF.jpg",36850],["When a Woman Ascends the Stairs",1960,4,1,"Mikio Naruse","Drama","miGb5TwM8SIK5URe0mPMOYZqr3g.jpg",36872],["Asparagus",1979,3,1,"Suzan Pitt","Animation","y80jnUURskTyujtMPKd9VQpMxSY.jpg",36881],["It's Not Just You, Murray!",1964,3,1,"Martin Scorsese","Comedy, Crime","szSH1IEEeHN2HljvGrEpw3eBjwY.jpg",36893],["True Lies",1994,3.5,1,"James Cameron","Action, Thriller","pweFTnzzTfGK68woSVkiTgjLzWm.jpg",36955],["Whisky",2004,4,1,"Juan Pablo Rebella & Pablo Stoll","Drama, Comedy","zteglNK16wK8kGD74J4npQyCUBl.jpg",36971],["31 Minutes: The Movie",2008,3,1,"Pedro Peirano & Álvaro Díaz González","Family, Comedy, Adventure","8OPMXLAIQGxagKOPkjMz12NK9o7.jpg",36999],["Fuga",2006,2.5,1,"Pablo Larraín","Drama, Thriller, Music","8oZ0me8AFv3181yiIsVjXkH11Db.jpg",37004],["Elephant",1989,4,1,"Alan Clarke","Drama, Crime","wznG0m1gY5lqEU7A14H2WESsqJX.jpg",37055],["Falling Down",1993,3.5,1,"Joel Schumacher","Crime, Drama, Thriller","7ujqyF96Zg3rfrsh9M0cEF0Yzqj.jpg",37094],["Tarzan",1999,4,4,"Kevin Lima","Family, Animation, Adventure","bTvHlcqiOjGa3lFtbrTLTM3zasY.jpg",37135],["The Naked Gun: From the Files of Police Squad!",1988,4,3,"Jerry Zucker & David Zucker & Jim Abrahams","Comedy, Crime","zT0mhZqZQJE1gSY5Eg9qcGP4NYo.jpg",37136],["The Naked Gun 2½: The Smell of Fear",1991,4,1,"Jerry Zucker & David Zucker & Jim Abrahams","Comedy, Crime","v9niLQWVzVPB1cP1ThNdEaLZG1Q.jpg",37137],["The Truman Show",1998,5,5,"Peter Weir","Comedy, Drama","vuza0WqY239yBXOadKlGwJsZJFE.jpg",37165],["The Graduate",1967,5,2,"Mike Nichols","Drama, Romance, Comedy","z1Z1tZMR66RxcNeHbwoEhYeqOlP.jpg",37247],["Witness for the Prosecution",1957,3.5,1,"Billy Wilder","Drama, Mystery, Crime","bCj4EfuehAlgBwVd3diyWyhuuau.jpg",37257],["Trust",1990,3,1,"Hal Hartley","Drama, Comedy, Romance","9wE7LuIkvuPfr4Ye6fMqPXHqaiE.jpg",37291],["Henry Fool",1997,3.5,1,"Hal Hartley","Comedy, Drama","1Uun13GJi5U0gs303e7BnER6SpG.jpg",37410],["Daughter",2011,3,1,"María Paz González","Horror, Thriller","dU5uJoWAcwNVH84G736i4f7oVot.jpg",37534],["Seven Beauties",1975,4,1,"Lina Wertmüller","Comedy, Drama, War","z1c93tNFz3ypiOpfQDji15nm98I.jpg",37550],["Super 8",2011,3,1,"J.J. Abrams","Thriller, Science Fiction, Mystery","pUWIjaMMYJjeBm5bJyE3mIXdQ62.jpg",37686],["The Tourist",2010,1.5,1,"Florian Henckel von Donnersmarck","Action, Thriller, Romance","qwfUH9gnvaXwvVRsgbL4L2jpLUz.jpg",37710],["A Night at the Opera",1935,2,1,"Sam Wood","Comedy, Music","A4YDGfJwaG7aMxDVrVJsOHJ7ufK.jpg",37719],["Skyfall",2012,4,1,"Sam Mendes","Action, Adventure, Thriller","d0IVecFQvsGdSbnMAHqiYsNYaJT.jpg",37724],["It's a Boy Girl Thing",2006,2,1,"Nick Hurran","Comedy, Fantasy, Romance","uA4ZJdlILmIGSqBjfM4mkWvtcTt.jpg",37725],["Easy A",2010,3.5,1,"Will Gluck","Comedy","v5f1qO6NJnxWgONgkYg21TW39DT.jpg",37735],["The Last Tycoon",1976,2.5,1,"Elia Kazan","Drama, Romance","sETEj1ieRCH4suyaW7D3q4XfFWJ.jpg",37774],["Whisper of the Heart",1995,4,1,"Yoshifumi Kondo","Animation, Drama, Family","5FROLD8zpWFs9ja7aYho1uOMJHg.jpg",37797],["The Social Network",2010,5,4,"David Fincher","Drama","n0ybibhJtQ5icDqTp8eRytcIHJx.jpg",37799],["Killers",2010,1,1,"Robert Luketic","Action, Comedy, Thriller, Romance","9VB8vGV4Aznf6GUc9C7a1EzGHLz.jpg",37821],["The White Ribbon",2009,5,1,"Michael Haneke","Drama, Mystery","54dlnGDexrwAFlDb8HWKfmmX4LB.jpg",37903],["Tales from Earthsea",2006,2,1,"Goro Miyazaki","Animation, Fantasy, Adventure","y0VnJt4eRPMjA1hpJ8f1EFoVaSf.jpg",37933],["You Will Meet a Tall Dark Stranger",2010,2.5,1,"Woody Allen","Comedy, Drama, Romance","oBhnI8UZQzTkAH1LMEtrBUmfpjS.jpg",38031],["The President's Barber",2004,3,1,"Lim Chan-sang","History, Drama, Comedy","cu31e4jAyOkUWmFzEUvZ7gvp3A7.jpg",38053],["Megamind",2010,3,1,"Eric Darnell & Tom McGrath","Animation, Action, Comedy, Family, Science Fiction","uZ9ytt3sPTx62XTfN56ILSuYWRe.jpg",38055],["Ambush",2001,3.5,1,"John Frankenheimer","Action","xLgVJm9ArF3mPCDIe9dzWQtfW3s.jpg",38183],["Hostage",2002,3.5,1,"John Woo","Action, Crime, Thriller, Adventure","d5CoQrPoN0h6h2BaZHAJNgWalJx.jpg",38185],["Powder Keg",2001,2,1,"Alejandro G. Iñárritu","Action, War","q9FgdaWOsHYEwck8nDqqna0kEbf.jpg",38187],["The Follow",2001,2.5,1,"Wong Kar-Wai","Action, Mystery, Romance","wAVZSrnlRQsNDrmwqIatzXLDjsN.jpg",38189],["Zookeeper",2011,1,1,"Frank Coraci","Comedy, Romance, Family","y3b4AYw8dr4hIKTfEAjxUxx0z8G.jpg",38317],["Transformers: Dark of the Moon",2011,1,1,"Michael Bay","Action, Science Fiction, Adventure","28YlCLrFhONteYSs9hKjD1Km0Cj.jpg",38356],["Grown Ups",2010,1,1,"Dennis Dugan","Comedy","cQGM5k1NtU85n4TUlrOrwijSCcm.jpg",38365],["The Firemen's Ball",1967,2.5,1,"Miloš Forman","Comedy","yylEjPttmTDar0o92StlrO5ghmw.jpg",38442],["For Rent",2005,2.5,1,"Alberto Fuguet","Comedy, Drama, Romance","27ab75lF1WzC2pchPbaN9Br8oZP.jpg",38476],["The Karate Kid (2010)",2010,2,1,"Harald Zwart","Action, Adventure, Drama, Family","b1RBy3l297N0c7PHjlz35cClWju.jpg",38575],["Marmaduke",2010,1,1,"Tom Dey","Family, Comedy","wNNqAqvOn717AWBhBQskH2Lnzmz.jpg",38579],["The Little Matchgirl",2006,3.5,1,"Roger Allers & Rob Minkoff","Animation, Drama, Family, Fantasy","GmeFUrGNdbXbWWjd78iDCmE4Ec.jpg",38580],["Godzilla vs. Mechagodzilla",1974,2.5,1,"Jun Fukuda","Action, Adventure, Science Fiction","ai92jga3nzkeWdPIeZBo6vyhUj5.jpg",38582],["The Danish Poet",2006,2.5,1,"Torill Kove","Animation","iZ40Z4BAHLiNVjZI28nY0xU9IAG.jpg",38635],["Cops",1922,3,1,"Buster Keaton","Comedy, Family, Adventure","uN8b6oQlmsb81G7GepgjPyRDLaO.jpg",38742],["Gulliver's Travels",2010,1,1,"Rob Letterman","Family, Comedy, Adventure, Fantasy","6NoEtuTwZ04luk5H2DpT5ivW7Mg.jpg",38745],["Tangled",2010,3.5,1,"Byron Howard","Animation, Family, Adventure","ym7Kst6a4uodryxqbGOxmewF235.jpg",38757],["Melvin and Howard",1980,3.5,1,"Jonathan Demme","Comedy, Drama","1oN3ZQPyJcSqoj0An39FSD8VFmC.jpg",38772],["Dogtooth",2009,4.5,2,"Yorgos Lanthimos","Drama","9AtxFlUOmeTtMMXYyz8azvN2few.jpg",38810],["The Beaches of Agnès",2008,4,1,"Agnès Varda","Documentary","mqTFhLpdyMNLBvmN5KFhCOFWWIp.jpg",38879],["Mrs. Dalloway",1997,3,1,"Marleen Gorris","Drama, Romance","kJURxFCyfqjTss7vTVMuUobHcye.jpg",38904],["Sorcerer",1977,3,1,"William Friedkin","Thriller, Adventure","2b7oexm173SF1FSEq0DdgxZZNRH.jpg",38985],["Winter's Bone",2010,3,1,"Debra Granik","Drama, Mystery","a0qhPkNlxLfsf5B2jFyI1Pp04XV.jpg",39013],["El Materdor",2008,2,1,"John Lasseter","Animation, Action, Comedy, Family","sW4IdZHsUOi6I4hAYtR92aeHUsC.jpg",39030],["Ritual",2000,4,1,"Hideaki Anno","Drama","h88yVKhgPAaPNEllDqsuhpQOJeL.jpg",39056],["Somewhere",2010,2,1,"Sofia Coppola","Drama","zOf1sdfF4eH3CVRCpmRO5ugVGdo.jpg",39210],["Real Steel",2011,2.5,1,"Shawn Levy","Action, Science Fiction, Drama","4GIeI5K5YdDUkR3mNQBoScpSFEf.jpg",39254],["To Joy",1950,3,1,"Ingmar Bergman","Romance, Drama, Music","8xvao8GSizgjaMfGijuaWcgjuAs.jpg",39284],["Mothra",1961,3.5,1,"Ishirō Honda","Adventure, Science Fiction, Fantasy","87hiAyyGFHPuuJ3iXHK8xZSMcRP.jpg",39410],["Little Fockers",2010,1.5,1,"Paul Weitz","Comedy, Romance","90mwPRNMmX9RUGVgKMJMJNQnYX8.jpg",39451],["The Gift",2013,3,1,"Banksy","Documentary","ruM5ehUQlHC1Kx3SF18d6klfrAx.jpg",39452],["Exit Through the Gift Shop",2010,3.5,1,"Banksy","Documentary","ruM5ehUQlHC1Kx3SF18d6klfrAx.jpg",39452],["Godzilla vs. Hedorah",1971,3.5,1,"Yoshimitsu Banno","Science Fiction, Action, Horror","mWVRlVwWK3sUCGd9lzMMWUa7CBu.jpg",39464],["Moolaadé",2004,3.5,1,"Ousmane Sembène","Drama","9S7lWdLExHw6LP3Vq7smiyGY5MR.jpg",39504],["Paul",2011,2.5,1,"Greg Mottola","Adventure, Comedy, Science Fiction","dKhexH8nS08lVlSmwSs00cHFxbY.jpg",39513],["Contagion",2011,4,1,"Steven Soderbergh","Drama, Thriller, Science Fiction","qL0IooP0bjXy0KXl9KEyPo22ll0.jpg",39538],["Gorillaz: Demon Days Live at the Manchester Opera House",2006,3.5,1,"David Barnard","Music, Documentary","oiE7BtugEmHbYYU972M5glrSRBc.jpg",39559],["The Kids Are All Right",2010,3.5,1,"Lisa Cholodenko","Comedy, Drama","xQ5XqZc82dDCcGjxY7voRKjhaKQ.jpg",39781],["The Cat Concerto",1947,4.5,1,"William Hanna & Joseph Barbera","Animation, Comedy, Music","eHo7MBlBMzG5nyLJ1jGRXUzBljP.jpg",39853],["The Night Before Christmas",1941,4,1,"William Hanna & Joseph Barbera","Animation, Comedy, Family","7j4T3n2YK5ySKvIMEqR3ljXsxkZ.jpg",39894],["Don't Answer the Phone!",1980,2,1,"Robert Hammer","Horror, Thriller","xKEeGK44NzyMzo6Ram5rgG893P.jpg",40102],["Mouse Trouble",1944,4,1,"William Hanna & Joseph Barbera","Animation, Comedy","2qCPjb3A5ap4oDJ7RtjqrJU23v0.jpg",40144],["16 Wishes",2010,1.5,1,"Peter DeLuise","Fantasy, Drama, Family","tO8TZvH83uHtrLnec6f684xfzOB.jpg",40205],["The Midnight Snack",1941,3,1,"William Hanna & Joseph Barbera","Comedy, Animation","8ATU8QpHIovzXvsAYaWCIwCePB0.jpg",40234],["Puss Gets the Boot",1940,3.5,1,"William Hanna & Joseph Barbera","Animation, Comedy","1YBzcEuKxSiWoWvGw1RU8CyrW1m.jpg",40372],["Psycho IV: The Beginning",1990,2,1,"Mick Garris","Horror, Mystery, Thriller, TV Movie","vxWTkQRAvTvA6rbBhsdC4pdnHuq.jpg",40377],["Led Zeppelin - The Song Remains the Same",1976,4,1,"Joe Massot","Music, Documentary","tQzNsYcg4rVXVGw45ue7nkdMOgs.jpg",40440],["Oasis: MTV Unplugged",1996,3.5,1,"Milton Lage","Music","z324XO4lenOehqw48LMbdYRc8Sq.jpg",40550],["Day & Night",2010,3,1,"Teddy Newton","Animation, Family, Comedy, Fantasy","hn2tOtidoYZ0D56jR4yknpdP1mU.jpg",40619],["A Town Called Panic",2009,3.5,1,"Stéphane Aubier & Vincent Patar","Adventure, Animation, Comedy, Family, Fantasy","9Q1jtFU1zutKsAR9lwAl6YMkgZM.jpg",40623],["The Heartbreak Kid",1972,3.5,1,"Elaine May","Romance, Comedy","5HtYW6taG3paHleY2LOCi44Qqei.jpg",40687],["Bedrooms and Hallways",1998,2,1,"Rose Troche","Comedy, Drama, Romance","tH02iMSE2qSmkl6i0x4sbhfS58M.jpg",40694],["Jimmy Timmy Power Hour",2004,1.5,1,"Butch Hartman","Animation, Comedy, Family, Fantasy, TV Movie, Science Fiction, Action","oJTKUJqa9vh2ZnYpq3dlYaZn73E.jpg",40706],["Trouble Every Day",2001,1.5,1,"Claire Denis","Drama, Horror, Thriller","jn4799m6uB5P6ZUarlnxvZEZDFp.jpg",40723],["Ashes of Time",1994,2.5,1,"Wong Kar-Wai","Drama, Action","ciyEwAbvoMHPP3281cgSnfslu43.jpg",40751],["The Green Hornet",2011,2,1,"Michel Gondry","Action, Crime, Comedy","pecyADOvb3Ksey7KYU6V1enEOEc.jpg",40805],["50/50",2011,3.5,1,"Jonathan Levine","Comedy, Drama","8f9tM9JVB4ETBhxlQcXIjLckArl.jpg",40807],["Gauche the Cellist",1982,2.5,1,"Isao Takahata","Animation, Music, Fantasy","31I321F0eePRVzsoMcbInmOgb22.jpg",41017],["La Notte",1961,4,1,"Michelangelo Antonioni","Drama, Romance","xkd7wPJSIC76scBRHCFZ85uOH5d.jpg",41050],["Make Way for Tomorrow",1937,4,1,"Leo McCarey","Drama, Romance","zPl6TfnIIJzdPXk9g6QPwFwTIt.jpg",41059],["Men in Black 3",2012,3,1,"Barry Sonnenfeld","Action, Comedy, Science Fiction","90DdoEStzeObs96fsYf4GG544iN.jpg",41154],["The Illusionist (2010)",2010,4,1,"Sylvain Chomet","Animation, Drama","Ac2tNYW9sRaOhmtMJQuhf2mvo00.jpg",41201],["Faster",2010,2,1,"George Tillman Jr.","Crime, Drama, Action, Thriller","AsUeaXrhw4oscCSjUZ6heh1pVvd.jpg",41283],["One from the Heart",1982,3.5,1,"Francis Ford Coppola","Drama, Romance","5EyIQksa8C9tm82rHIJYGQXZ5Vs.jpg",41291],["Day of Wrath",1943,4,1,"Carl Theodor Dreyer","Drama, History","jEOqbGLFo8fxHHgYoZVTMVYMoQG.jpg",41391],["Tetsuo: The Iron Man",1989,4,1,"Shinya Tsukamoto","Horror, Science Fiction","9RquCMBJ42Kq7ASBy0qcyVP0ugi.jpg",41428],["Saw 3D",2010,1.5,1,"Kevin Greutert","Horror, Crime","qHCZ6LjtmqWDfXXN28TlIC9OppK.jpg",41439],["Scream 4",2011,3.5,1,"Wes Craven","Horror, Mystery","tcrI37K98TVopLbcZBa55mWhLT1.jpg",41446],["3 Women",1977,4,1,"Robert Altman","Drama","uL5Yg8MEgHGXymTaJBYXn9g0xsH.jpg",41662],["Jacquot de Nantes",1991,3.5,1,"Agnès Varda","Drama","cg0Z7kqFbDOBWNanI7uYHzsTiU5.jpg",41789],["The Funeral",1984,3,1,"Jūzō Itami","Comedy, Drama","qZ2o9jMfucCvGCcZxSNeLAAnF7G.jpg",42095],["Blood Wedding",1981,3,1,"Carlos Saura","Drama, Music","lfLdKbwayLuXkU8ZHFJoNSsbPI1.jpg",42139],["Hardcore",1979,3.5,1,"Paul Schrader","Drama, Crime, Thriller","g6m9xBTAzxXVhdJ624s9BLK9o6.jpg",42172],["Never Let Me Go",2010,3.5,1,"Mark Romanek","Drama, Romance, Science Fiction","7okcm65P7WfpF3f0HiQBFTsvcXV.jpg",42188],["Julia",1977,2,1,"Fred Zinnemann","Drama, Romance, Thriller","qHtPzs9eVCilp88c1arq73gH6xk.jpg",42222],["A Special Day",1977,4.5,1,"Ettore Scola","Drama, Romance","jzRn7N1mFowkQ5IkUkfWoxXJtYU.jpg",42229],["We All Loved Each Other So Much",1974,4,1,"Ettore Scola","Drama, Comedy","zGGWYpiKNwjpKxelPxOMqJnUgDs.jpg",42269],["Life with Mikey",1993,2,1,"James Lapine","Comedy, Family","dKsvF5t5xsm17HG3GJzQQGJpJzP.jpg",42580],["The Pleasure of Being Robbed",2008,2.5,1,"Josh Safdie & Benny Safdie","Drama, Crime","u4TVFGuAgx75OEsYwpVn1ESp6iC.jpg",42585],["Hi, Mom!",1970,3,1,"Brian De Palma","Comedy, Crime","l4rge37nxK6nQFQVJxgdRaBG1xS.jpg",42589],["The Passion of Anna",1969,3,1,"Ingmar Bergman","Drama","cr01316AyxUZyZrdLwzz3AXrgJc.jpg",42602],["Sweet Charity",1969,3,1,"Bob Fosse","Comedy, Music, Romance, Drama","wYYsAxhU1XgzkNa7jOsVGWROSB2.jpg",42618],["Who's That Knocking at My Door",1967,3,1,"Martin Scorsese","Drama, Romance","zcH6pKZKeImwcBtIH7fSdUyoQ2e.jpg",42694],["Yesterday, Today and Tomorrow",1963,3,1,"Vittorio De Sica","Comedy, Romance","vydCOfhrnKqMSbYcI0cUkkKuCND.jpg",42801],["The Servant",1963,4,1,"Joseph Losey","Drama","pRa4og93BeOoMCt6oWuPCwu5Coo.jpg",42987],["F for Fake",1973,4.5,1,"Orson Welles","Documentary","fVeIDxS73CrosoeVOaefQuCUGZg.jpg",43003],["The Colossus of Rhodes",1961,2,1,"Sergio Leone","Adventure, Drama, History","xb5PBtqe5rHJkuXwwJGxXwjUcZA.jpg",43020],["Ghostbusters (2016)",2016,1.5,1,"Paul Feig","Action, Fantasy, Comedy","wJmWliwXIgZOCCVOcGRBhce7xPS.jpg",43074],["The H-Man",1958,2,1,"Ishirō Honda","Science Fiction, Horror","q0TBsVeBcXI1GrW0zfD2wCN5Zum.jpg",43113],["Friendly Persuasion",1956,2.5,1,"William Wyler","Drama, War","mhsdObvFHoOfgaKAVJUOeK3LiOP.jpg",43258],["How Green Was My Valley",1941,3.5,1,"John Ford","Drama","8N7OmxBqjRVUrqergUduGgr6exy.jpg",43266],["All That Heaven Allows",1955,4,1,"Douglas Sirk","Drama, Romance","9BZRrJK3iMILX0KP8eLb2E4sPqs.jpg",43316],["Love & Other Drugs",2010,2,1,"Edward Zwick","Drama, Comedy, Romance","wZLM2uKJRYNchLmiCIjosX0rXy8.jpg",43347],["The Life of Oharu",1952,3,1,"Kenji Mizoguchi","Drama","8sIZjJdLrXPxrSERSLese1gUIwt.jpg",43364],["Miracle in Milan",1951,4,1,"Vittorio De Sica","Comedy, Fantasy, Drama","zMEYCBO2OBHR09aW9IwjOR3R3A5.jpg",43379],["The Wind Will Carry Us",1999,3,1,"Abbas Kiarostami","Drama","tzrqZungDYA3Djp61NWUm7DtxNI.jpg",43423],["Time for Revenge",1981,4,1,"Adolfo Aristarain","Crime, Drama, Thriller","toMHQMl23CGboMUX9dR7V3OxbsF.jpg",43428],["Martin (Hache)",1997,4,1,"Adolfo Aristarain","Drama","pe7dC06Eb0hNKzWSsHtA2oTUDK9.jpg",43429],["Shoeshine",1946,4,1,"Vittorio De Sica","Drama","qhhbo7rzJ1U8y1jW5cpR2j5GhvR.jpg",43469],["Doodlebug",1997,2.5,1,"Christopher Nolan","Horror","zomfKkYlS6oeiTUUfqHYHrnI2sk.jpg",43629],["The Landlord",2007,3,1,"Adam McKay","Comedy","jvmHEJlo0gaOdPGHLd9bermaGls.jpg",43631],["Superman/Shazam!: The Return of Black Adam",2010,3,1,"Joaquim Dos Santos","Animation, Action, Adventure, Science Fiction","3MgwChvi42N1RnhQE9A4pQVHyUY.jpg",43641],["The Legend of Sleepy Hollow",1949,3,1,"Clyde Geronimi","Family, Animation, Horror, Comedy","6bt8qmhxVsgbxFLQCoAcekdCFiw.jpg",43650],["The Perfect Human",1968,3,1,"Jørgen Leth","Drama","zlDCJ4jhVRP9RsWwVVM75wP3dOa.jpg",43681],["Only Angels Have Wings",1939,4,1,"Howard Hawks","Romance, Adventure, Drama","lqcwiWancAkjtAQPHr9V3SfJjBM.jpg",43832],["A Day in the Country",1946,3.5,1,"Jean Renoir","Drama, Romance, Comedy","r490HjrQJrYXJp1zkzbflwEIegT.jpg",43878],["L'Atalante",1934,3,1,"Jean Vigo","Comedy, Drama, Romance","qg3PQG6QeFpcg45XhYQpsYcabna.jpg",43904],["It's Kind of a Funny Story",2010,2,1,"Ryan Fleck & Anna Boden","Comedy, Drama, Romance","hQE4q8Szeaae4davgB7o8MTLmwr.jpg",43923],["I'm Here",2010,3.5,1,"Casey Affleck","Music, Comedy, Drama","h8c53OPv2miF6vzpVXQZX8jw1pJ.jpg",43939],["I'm Still Here (2010)",2010,3,1,"Casey Affleck","Music, Comedy, Drama","h8c53OPv2miF6vzpVXQZX8jw1pJ.jpg",43939],["Flipped",2010,3,1,"Rob Reiner","Romance, Drama","6zDYFigohwncqFL00MKbFV01dWb.jpg",43949],["A Moment of Innocence",1996,4,1,"Mohsen Makhmalbaf","Drama, Comedy","jBgImBSOFUJg8voD7xbLqS1s1tf.jpg",43976],["Another Year",2010,4,1,"Mike Leigh","Drama, Comedy","zrkQcAatfBox5x9KZjaYGnKoqu6.jpg",44009],["Jeanne Dielman, 23, quai du Commerce, 1080 Bruxelles",1975,3.5,1,"Chantal Akerman","Drama","csauSgjRDwdGJfQKWe1zpeXXS5q.jpg",44012],["Vagabond",1985,3.5,1,"Agnès Varda","Drama","2KFfwiPct1hwqi9dkKqoom0BenC.jpg",44018],["The House Is Black",1963,3,1,"Forugh Farrokhzad","Documentary","wPiSeBkcIRL0r3XQ0FeNhh19mW0.jpg",44065],["127 Hours",2010,3.5,1,"Danny Boyle","Adventure, Drama, Thriller","h0RMdn0rfl9l5hWXz3tUh6QVkhi.jpg",44115],["Wild Target",2010,2.5,1,"Jonathan Lynn","Action, Comedy","ejKD5DQ7jouzEkz1fx5Fr8li2ZA.jpg",44147],["Michael Jackson: Bad",1987,3.5,1,"Martin Scorsese","Music","yjypkuPLgxwiSJwkECQvf57HlnK.jpg",44204],["Black Swan",2010,4.5,1,"Darren Aronofsky","Drama, Thriller, Horror","viWheBd44bouiLCHgNMvahLThqx.jpg",44214],["The Lunch Date",1989,3.5,1,"Adam Davidson","Comedy, Drama","2nCytIaQ92TW0UmvTOGxoxHnJKE.jpg",44231],["The Alphabet",1969,3.5,1,"David Lynch","Animation, Horror","thTiEL6egntN6g0qefN1Kie3HdI.jpg",44239],["True Grit",2010,4,2,"Joel Coen & Ethan Coen","Drama, Adventure, Western","tCrB8pcjadZjsDk7rleGJaIv78k.jpg",44264],["The Silences of the Palace",1994,3,1,"Moufida Tlatli","Drama","c8QQRaI3k3LNUqYKmlKldhLpgYK.jpg",44284],["The Mermaid (1904)",1904,2.5,1,"Georges Méliès","Fantasy","ephwcaKv583rxK7HQGej1moEKl3.jpg",44328],["Life of an American Fireman",1903,2.5,1,"Edwin S. Porter","Action","fEGJ6hwsjwB844f9CMRjzHjZF0P.jpg",44341],["The Black Imp",1905,2.5,1,"Georges Méliès","Fantasy, Comedy","lQRPL9yOPKR26kBXmzkisTALYB0.jpg",44342],["Rabbits",2002,3.5,1,"David Lynch","Horror, Mystery, Crime, Drama, Thriller","d2xy1yFP6Whael1l922OcZ3qpBm.jpg",44351],["The Gleaners and I",2000,4,1,"Agnès Varda","Documentary","6IdCTKi4Eu7i897jpe59wIDGCri.jpg",44379],["That Moment: Magnolia Diary",2000,3,1,"Mark Rance","Documentary","vlOelEmKcvlKjkf01Elk9vGXnm5.jpg",44387],["The Holy Girl",2004,3.5,1,"Lucrecia Martel","Drama","srA4HPJe0YpDTZ4L4Nj5psD7v48.jpg",44413],["At Land",1944,3.5,1,"Maya Deren","Fantasy","97g5V60msJWADVBJyJMpzmRZAnd.jpg",44445],["Red Hot Riding Hood",1943,3,1,"Tex Avery","Animation, Comedy","16s0F2Ao6xLS6BSJtvRNXObVJsV.jpg",44468],["Wasp",2003,3,1,"Andrea Arnold","Drama","9W6dKmIYyrw3clcwTT9VIUero9X.jpg",44472],["The Watermelon Woman",1996,3,1,"Cheryl Dunye","Drama, Comedy, Romance","mBBqKfkvzSk6Rk7bfRXU9kR916N.jpg",44479],["Zero for Conduct",1933,3,1,"Jean Vigo","Comedy, Drama","oQcGB9BGj9LPTWcEdij47McotKY.jpg",44494],["The Grandmother",1970,3.5,1,"David Lynch","Animation, Horror","llhiY0rV6RWU1LOdy9Zljhf7cXm.jpg",44510],["Same Love, Same Rain",1999,4,1,"Juan José Campanella","Comedy, Romance","qSeUv634CRFlHsmdXcUCQkcxqAt.jpg",44516],["Animal Kingdom",2010,3,1,"David Michôd","Crime, Drama","zhj8YPQKuRev5N3KoHacsPnF4mB.jpg",44629],["Margaret",2011,4,1,"Kenneth Lonergan","Drama","zqBao8uRH6TQAJd13tqC22vPB76.jpg",44754],["Hugo",2011,4,2,"Martin Scorsese","Adventure, Drama, Family","1dxRq3o3l3bVWNRvvSb7rRf68qp.jpg",44826],["The Grandmaster",2013,3,1,"Wong Kar-Wai","Action, Drama, History","ydBVVIscL6TsX5hYztA5YpBCwJ3.jpg",44865],["Rango",2011,3.5,1,"Gore Verbinski","Animation, Comedy, Family, Western, Adventure","A5MP1guV8pbruieG0tnpPIbaJtt.jpg",44896],["Green Lantern",2011,1.5,1,"Martin Campbell","Adventure, Action, Science Fiction","fj21HwUprqjjwTdkKC1XZurRSpV.jpg",44912],["For Colored Girls",2010,1.5,1,"Tyler Perry","Drama","lj7SFMEUL0BRi41TDdVTVcq70Gt.jpg",44944],["Super",2010,3,1,"James Gunn","Comedy, Action, Drama","jZrRMGSajZQehg8mz74A5A00L3.jpg",45132],["Enthusiasm. Symphony of Donbas",1930,3,1,"Dziga Vertov","Documentary","tWx63XY4g1Guh98QCj8W2xZ9Xiv.jpg",45176],["Soccer Stories",1997,3,1,"Andrés Wood","Drama","hyKYkJfKjMNIbTow9p1lMw0HWby.jpg",45180],["The River",1951,3.5,1,"Jean Renoir","Drama, Romance","rC1k4xkffb5sdQlktiP2TyiBxT2.jpg",45218],["The Hangover Part II",2011,2,1,"Todd Phillips","Comedy","cKZu0Fdkj7dmwbfMpgDqVVCkLJQ.jpg",45243],["The King's Speech",2010,3.5,1,"Tom Hooper","Drama, History","pVNKXVQFukBaCz6ML7GH3kiPlQP.jpg",45269],["The Seafarers",1953,2.5,1,"Stanley Kubrick","Documentary","nSucFIAQ5CowEE1WZ87mz3OsbQ1.jpg",45314],["The Fighter",2010,3.5,1,"David O. Russell","Drama","xfsFerGhO1h6rLk8vwLgMyQ8WVJ.jpg",45317],["Isle of Flowers",1989,4,1,"Jorge Furtado","Documentary","cghvWnWK5AuIKPY92YRV9tCeNhw.jpg",45318],["I Knew It Was You: Rediscovering John Cazale",2009,3.5,1,"Richard Shepard","Documentary","6a00p3eRZKjvDeYY2tHN057Jvx0.jpg",45485],["Source Code",2011,3,1,"Duncan Jones","Thriller, Science Fiction, Mystery","nTr0lvAzeQmUjgSgDEHTJpnrxTz.jpg",45612],["Rubber",2010,2.5,1,"Quentin Dupieux","Comedy, Drama, Fantasy, Horror, Mystery","mWgCORI5IC5vOvB2cDVQe0YNtXZ.jpg",45649],["Plane Crazy",1928,2.5,1,"Walt Disney","Animation, Comedy","aThtlWk7kyvjNQ2H4GX5ixKVzlb.jpg",45665],["Tokyo Drifter",1966,3,1,"Seijun Suzuki","Thriller, Crime, Action","dkscSldTB6FGUMMLnInUfKYLfPR.jpg",45706],["Gnomeo & Juliet",2011,2,1,"Kelly Asbury","Animation, Family","vVQwgfS9gSFviVT4gS7tZAmhRFc.jpg",45772],["Day of the Fight",1951,2.5,1,"Stanley Kubrick","Documentary","7OEwDK1Fdz8R7Xo9cDWANjiz7vH.jpg",45966],["Flying Padre",1951,2.5,1,"Stanley Kubrick","Documentary","5aog5qVlMFakpogT1Nar9Z7gqq4.jpg",45970],["Rio",2011,2.5,1,"Carlos Saldanha","Animation, Adventure, Comedy, Family","4nJxhUknKV8Gqdhov8pU1YWDYfb.jpg",46195],["Guy and Madeline on a Park Bench",2009,2.5,1,"Damien Chazelle","Drama, Music, Romance","7bu5XiVNVSlJkdihAv7Bnkdah3i.jpg",46504],["The High Sign",1921,3.5,1,"Buster Keaton","Crime, Comedy","oIrAPIj3EnRGcp7IiaRrntgcMaq.jpg",46510],["Blue Valentine",2010,4.5,1,"Derek Cianfrance","Drama, Romance","dc8BdKnDY5Iy28KzUGtHIXuqqFK.jpg",46705],["Incendies",2010,4.5,2,"Denis Villeneuve","Drama, War, Mystery","yH6DAQVgbyj72S66gN4WWVoTjuf.jpg",46738],["Trash Humpers",2009,1.5,1,"Harmony Korine","Comedy, Horror","sNMA5i8w6MsyTKPULhJuLUHB2Wd.jpg",46788],["Submarino",2010,3,1,"Thomas Vinterberg","Drama","kzkQqjphmXSMoJjxOGcDitPhjAs.jpg",46789],["The Two Mouseketeers",1952,3,1,"William Hanna & Joseph Barbera","Animation, Comedy, Adventure","Japp305ExR2Di8sUfYswlaDAM9.jpg",46852],["Daisies",1966,3.5,1,"Věra Chytilová","Comedy, Drama","8sxMhdn3i1Pn8OlGCBBjr9rjP1y.jpg",46919],["They Caught the Ferry",1948,4,1,"Carl Theodor Dreyer","Drama","r8QmSlw8G463VTO4Vfup6uVd48g.jpg",46984],["Chronicle of a Boy Alone",1965,3,1,"Leonardo Favio","Drama","yxdgxxtFfZUbn5idvtLSh4ryol3.jpg",47142],["Ferdinand the Bull",1938,3,1,"Dick Rickard","Animation, Comedy, Family","b39Ydh8pmHjRyUUURLoVOdNxz5m.jpg",47166],["Faster, Faster",1981,4,1,"Carlos Saura","Crime, Drama, Romance","93aeKG6qQ2feWX2lAZcjUATYpwc.jpg",47211],["Jumping",1984,4,1,"Osamu Tezuka","Animation, Fantasy","6nt0qXgC5sY1diXfMIs6BB4Yrcq.jpg",47217],["Cairo Station",1958,3,1,"Youssef Chahine","Crime, Drama, Thriller","zm8ET6PSfPT6pozgvjR7htaZFjy.jpg",47324],["Samurai Jack: The Premiere Movie",2001,4,1,"Genndy Tartakovsky","Science Fiction, Action, Animation, Fantasy, TV Movie, Adventure","exiLlum3asi9ONYeolOpONZTbKf.jpg",47388],["Summer Interlude",1951,3,1,"Ingmar Bergman","Drama, Romance","3Yl2nPAzBcygds63L6yf4g7I2k8.jpg",47473],["Memories of Underdevelopment",1968,4,1,"Tomás Gutiérrez Alea","Drama","av7zEHpOyzmm86VPRa68zOLaBqf.jpg",47576],["Easy Street",1917,2.5,1,"Charlie Chaplin","Comedy, Action","pEPeUV0OCUMXAub5jm8Woqzg36p.jpg",47650],["The Immigrant",1917,3,1,"Charlie Chaplin","Comedy, Romance","f4xP9DvXKqpYKo0Fth5tKyZY8ej.jpg",47653],["Othello",1951,3,1,"Orson Welles","Drama","61A7EJqfMsrQO0YWsUWq8gbgbu0.jpg",47697],["Sawdust and Tinsel",1953,3.5,1,"Ingmar Bergman","Drama","o1LGjSnibRtFuoBXrttm6pueNiD.jpg",47721],["Summer with Monika",1953,4.5,1,"Ingmar Bergman","Drama, Romance","82hLsn67V9TjgrLOZCFL7247pJd.jpg",47735],["À propos de Nice",1930,3.5,1,"Jean Vigo","Documentary","mAr8wThrq5qrV571luLnYgdTcPY.jpg",47831],["Elite Squad: The Enemy Within",2010,3,1,"José Padilha","Drama, Action, Crime","c7yCrf3PTSdp6RMGktZQhzFcFFM.jpg",47931],["Independence Day: Resurgence",2016,1,1,"Roland Emmerich","Action, Adventure, Science Fiction","9S50foUIYGwiNPWOxi1WJF6IPwI.jpg",47933],["Ordet",1955,4.5,1,"Carl Theodor Dreyer","Drama","q8DuzIhRsDGeCJaB9K80Fqtq6Y4.jpg",48035],["Unknown",2011,2.5,1,"Jaume Collet-Serra","Action, Mystery, Thriller","aXBQD515okXQZmYA89ntXMvSJSd.jpg",48138],["El Sur",1983,4.5,1,"Víctor Erice","Drama","bAyghNTLIwHIxoQOha6kHfwmxS6.jpg",48139],["The Devil's Eye",1960,3.5,1,"Ingmar Bergman","Comedy, Fantasy, Drama","njgS53DDdtsj5DXaGcEwglwq8z3.jpg",48145],["Nights and Weekends",2008,2,1,"Greta Gerwig","Drama, Romance","zFPvD0dxmqrfKu0qqAgzGVEfCn3.jpg",48204],["A Dangerous Method",2011,2.5,1,"David Cronenberg","Drama","7TPYtzq9ABkfED1JB0tRASamL4z.jpg",48231],["Alvin and the Chipmunks Meet the Wolfman",2000,1.5,1,"Kathi Castillo","Family, Fantasy, Comedy, Animation, Music","xvAGKjbAl2F71hterQ6BpPzQMEc.jpg",48246],["Certified Copy",2010,4.5,1,"Abbas Kiarostami","Drama, Romance","soBvtCR33Gv1j6gXwXOIc3JTlNc.jpg",48303],["Lumière & Company",1995,3,1,"MANY","Drama, Documentary","bSQ394UJb2xjMfwucHiHxg8XR5f.jpg",48336],["The Old Lady and the Pigeons",1997,3,1,"Sylvain Chomet","Animation, Comedy","cr9Qsgv2IoEnlbT12WGDEOxQW5G.jpg",48347],["Time Piece",1965,4,1,"Jim Henson","Comedy, Music, Fantasy","7a4wesc1fdaHQ4DpfsdWy9WuuTs.jpg",48441],["The Big Shave",1967,3,1,"Martin Scorsese","Horror, Drama","1bgOIU4ezln7qqVymjQBLEYMPpb.jpg",48714],["What's a Nice Girl Like You Doing in a Place Like This?",1963,3,1,"Martin Scorsese","Comedy","1ScWXMXy993ckjrwb0JE09ew7PL.jpg",48717],["Six Men Getting Sick",1967,3.5,1,"David Lynch","Animation","5QGip6FQy0x3TcC7hkbV2IcYgj.jpg",48784],["Man Facing Southeast",1986,3,1,"Eliseo Subiela","Mystery, Science Fiction, Drama","vxTNlao45QcCr97s0VcBFXXIxF6.jpg",48797],["The Amputee",1974,2.5,1,"David Lynch","Drama, Comedy","6yRz5TOhNCbpOQ76daKSPh8x3Fe.jpg",48847],["The Life of Fish",2010,3.5,1,"Matías Bize","Romance, Drama","fEQgrh6veqfwJpFSVvaQIhi03qz.jpg",48999],["Hobo with a Shotgun",2007,2.5,1,"Jason Eisener","Crime, Action, Thriller","xxMaO7VoN2BnZit79PedVHnTjcO.jpg",49010],["Cars 2",2011,2,1,"John Lasseter","Animation, Family, Adventure, Comedy","okIz1HyxeVOMzYwwHUjH2pHi74I.jpg",49013],["Insidious",2010,2.5,1,"James Wan","Horror, Thriller","1egpmVXuXed58TH2UOnX1nATTrf.jpg",49018],["Submarine",2010,3.5,1,"Richard Ayoade","Drama, Comedy, Romance","nbzXX3CYtKUBrPeMcG7PVoLQHXB.jpg",49020],["The Dark Knight Rises",2012,3,1,"Christopher Nolan","Action, Crime, Drama, Thriller","hr0L2aueqlP2BYUblTTjmtn0hw4.jpg",49026],["The Bourne Legacy",2012,2,1,"Tony Gilroy","Action, Thriller","1aExL5DTGHj25ZfIC3dDwS84RWi.jpg",49040],["All Quiet on the Western Front (2022)",2022,3,1,"Edward Berger","War, Drama","2IRjbi9cADuDMKmHdLK7LaqQDKA.jpg",49046],["Gravity",2013,3.5,1,"Alfonso Cuarón","Science Fiction, Thriller, Drama","kZ2nZw8D681aphje8NJi8EfbL1U.jpg",49047],["Dredd",2012,3.5,1,"Pete Travis","Action, Science Fiction","wLx65gtGVnUFCxceHWGszcruCZj.jpg",49049],["The Hobbit: An Unexpected Journey",2012,3.5,2,"Peter Jackson","Adventure, Fantasy, Action","yHA9Fc37VmpUA5UncTxxo3rTGVA.jpg",49051],["The Office",1966,3,1,"Krzysztof Kieślowski","Documentary","8eK9f7mfG2ZZVDvOlW97kF6JGp6.jpg",49097],["Gorath",1962,2,1,"Ishirō Honda","Science Fiction, Action, Thriller","390PCxjm9GSuMUZ0nIMMCMFJgbx.jpg",49163],["Ali Zaoua: Prince of the Streets",2000,3,1,"Nabil Ayouch","Drama","5Uf2zhivRpxTNI9c1MjGwjT3Szx.jpg",49167],["A Corner in Wheat",1909,3,1,"D.W. Griffith","Drama","wwwC7ItjZeXnH4bL3FI0p5MWUES.jpg",49270],["The Melomaniac",1903,3.5,1,"Georges Méliès","Comedy, Music","8zxXYUEneCVBQGhSylw7Amr1Tpc.jpg",49273],["The Man with the Rubber Head",1901,3.5,1,"Georges Méliès","Comedy, Fantasy","h268Nn1UjDm5x02tkEgId7CF9Q.jpg",49279],["The One-Man Band",1900,3,1,"Georges Méliès","Comedy, Fantasy, Music","g3YDMnAhIDABS4cXYzT54Cp0QiW.jpg",49280],["The Four Troublesome Heads",1898,3,1,"Georges Méliès","Comedy, Fantasy","epFT2yQn189iHMqRTf9oZAyIg31.jpg",49296],["Kung Fu Panda 2",2011,3,1,"Jennifer Yuh Nelson","Animation, Family, Comedy, Action","A23nZfFBa7gFD40IsiV5gOadyIi.jpg",49444],["The Short & Curlies",1987,3.5,1,"Mike Leigh","Comedy, Romance, TV Movie","vHPJGFP7UONECmRW1blxcJ5clJ6.jpg",49455],["Saute ma ville",1968,2.5,1,"Chantal Akerman","Drama, Comedy","cky7DIVzjZab5O05JmlM33OvEYQ.jpg",49479],["Sniffer",2006,2,1,"Bobbie Peers","Drama, Science Fiction","99VnE60YcBHjgf3I3fVuptmWQJY.jpg",49484],["Gasman",1998,4.5,1,"Lynne Ramsay","Drama","s58XvzjJv0ZxNo1gySiKlyRsAyj.jpg",49486],["Kill the Day",1996,3,1,"Lynne Ramsay","Drama","hfGKe70WfqMyH9MXIGfiHPHuBCh.jpg",49488],["Small Deaths",1996,3.5,1,"Lynne Ramsay","Drama","omKRrrKnkghLxiML7YFKJ7ACmHE.jpg",49489],["Tinker Tailor Soldier Spy",2011,3,1,"Tomas Alfredson","Drama, Thriller, Mystery","e0dZ7TapGY9HtJ9xk1TUHPEOccl.jpg",49517],["The Croods",2013,1.5,1,"Kirk DeMicco","Animation, Adventure, Family, Comedy","27zvjVOtOi5ped1HSlJKNsKXkFH.jpg",49519],["Man of Steel",2013,2.5,1,"Zack Snyder","Action, Adventure, Science Fiction","8GFtkImmK0K1VaUChR0n9O61CFU.jpg",49521],["John Carter",2012,2,1,"Andrew Stanton","Action, Adventure, Science Fiction","lCxz1Yus07QCQQCb6I0Dr3Lmqpx.jpg",49529],["In Time",2011,1.5,1,"Andrew Niccol","Action, Thriller, Science Fiction","3Mwj2sIONQckOZP3YwsUXF7U5I4.jpg",49530],["X-Men: First Class",2011,3,1,"Matthew Vaughn","Action, Science Fiction, Adventure","hNEokmUke0dazoBhttFN0o3L7Xv.jpg",49538],["The Man Who Planted Trees",1987,4,1,"Frédéric Back","Animation, Drama, Fantasy","tEzdXghDipM4b8Qs1mzt4mvXT6l.jpg",49565],["Daguerréotypes",1975,4.5,1,"Agnès Varda","Documentary","gzl6XppRi8C3fhKYCAsWcjGjcUF.jpg",49650],["Marriage Italian Style",1964,4,1,"Vittorio De Sica","Drama, Romance, Comedy","1VVQFXwr4i6QSAoPnCs9UmGTUVw.jpg",49687],["Johnny One Hundred Pesos",1993,3.5,1,"Gustavo Graef-Marino","Drama, Crime","nLvLJ0HmRvhQtJ2MD7Edjew2Pcf.jpg",49688],["Red Riding Hood",2011,1,1,"Catherine Hardwicke","Thriller, Drama, Fantasy, Mystery, Horror, Romance","ixQYkLeLlTTnAoT32dukndyObB6.jpg",49730],["I Saw the Devil",2010,4,1,"Kim Jee-woon","Thriller, Horror","zp5NrmYp80axIGiEiYPmm1CW6uH.jpg",49797],["The Daytrippers",1996,3.5,1,"Greg Mottola","Comedy, Drama","bDmconT9Fj0dnXdV5LaGAxXrVFN.jpg",49806],["Fantasia 2000",1999,3.5,1,"MANY","Animation, Family, Music","5rwAtUaKEK48CPUijVfVU0IPKPZ.jpg",49948],["Where Is the Friend's House?",1987,4,1,"Abbas Kiarostami","Drama, Adventure","2rTW4s1kgvoqVs0Kv8ARle1SrkF.jpg",49964],["The Help",2011,3.5,1,"Tate Taylor","Drama","3kmfoWWEc9Vtyuaf9v5VipRgdjx.jpg",50014],["Cousin",1999,3.5,1,"Des McAnuff","Comedy, Drama, Romance","4TEMm2pyZ6mYBmP2AwoierJHQf9.jpg",50043],["Hardware Wars",1978,1,1,"Ernie Fosselius","Comedy, Science Fiction","5gueOnWMxzg9ngNjsM1M557VzKM.jpg",50157],["The Ascent",1977,3.5,1,"Larisa Shepitko","Drama, War","hJOju5XZfmq4Lg5dPa8IPVY3mDt.jpg",50183],["TPB AFK: The Pirate Bay - Away from Keyboard",2013,3,1,"Simon Klose","Documentary, Crime","tTgeYhe5V7tF3gV7ZPwgsTqVDfO.jpg",50275],["Hop",2011,1,1,"Tim Hill","Animation, Comedy, Family","2FrDmwXWjRE1zpNP288YncRt5RF.jpg",50359],["Hanna",2011,2.5,1,"Joe Wright","Action, Thriller, Adventure","6QDeHwBXDHbCbuzStgUpuUAqnap.jpg",50456],["Friends with Benefits",2011,2,1,"Will Gluck","Romance, Comedy","nKhhDFCdzxeJ3GUunQ570LDpUkz.jpg",50544],["The Twilight Saga: Breaking Dawn – Part 2",2012,1,1,"Bill Condon","Adventure, Fantasy, Romance","qs8LsHKYlVRmJbFUiSUhhRAygwj.jpg",50619],["The Twilight Saga: Breaking Dawn – Part 1",2011,0.5,1,"Bill Condon","Adventure, Fantasy, Romance","qs8LsHKYlVRmJbFUiSUhhRAygwj.jpg",50619],["Crazy, Stupid, Love.",2011,3.5,1,"Glenn Ficarra","Comedy, Drama, Romance","p4RafgAPk558muOjnBMHhMArjS2.jpg",50646],["The Servant (2010)",2010,2.5,1,"Kim Dae-woo","Romance, Drama, Comedy","t7vY6aU6rDNNDGFni604dk6FgIR.jpg",50727],["7 Plus Seven",1970,3.5,1,"Michael Apted","Documentary","3vS9ONmc4V4Hoi02WNnSGHnOyGg.jpg",50754],["An Autumn Afternoon",1962,4.5,1,"Yasujirō Ozu","Drama","4RtWkqywkzxonlnGBwv4RpSw4Rb.jpg",50759],["Burnt by the Sun",1994,3,1,"Nikita Mikhalkov","Drama","jcpvnPSuRrynrgY7menuyZe7X4r.jpg",50797],["Madea's Big Happy Family",2011,0.5,1,"Tyler Perry","Comedy, Drama","6qWcpqRfUEFrbKdDvB7tg7h1oXz.jpg",51017],["Decalogue II",1989,3.5,1,"Krzysztof Kieślowski","Drama, TV Movie","jil1lzNPa6fQWh2JG7Khc7MLjKt.jpg",51108],["Decalogue IV",1989,4,1,"Krzysztof Kieślowski","Drama, TV Movie","u0OHhueacQS9mT6HnrF3ivdxnxc.jpg",51110],["Decalogue VIII",1989,2.5,1,"Krzysztof Kieślowski","Drama, TV Movie","bJ60dOPRq3M0Dkbpnp5jrl2UfVX.jpg",51111],["Heartbeats",2010,3.5,1,"Xavier Dolan","Drama, Romance","kBGbvzrP4lNV4BZc2wscmglNno2.jpg",51241],["Placido",1961,3.5,1,"Luis García Berlanga","Comedy","9xzbq4B8z9i53KGvIhBIKSDyoCa.jpg",51317],["The Haunted House",1923,3,1,"Buster Keaton","Comedy, Horror","yKAgNQhI55Ennhd3SmU1UxvXiQ3.jpg",51359],["The Frozen North",1922,2.5,1,"Buster Keaton","Comedy, Western","gz0zcPq6oG27v23abgeZD5NzCW0.jpg",51364],["Neighbours",1952,4,1,"Norman McLaren","Animation, Comedy","ccpiARQxBBWaL2Ik8ke9yjq7qrM.jpg",51406],["Fast Five",2011,3,1,"Justin Lin","Action, Thriller, Crime","gEfQjjQwY7fh5bI4GlG0RrBu7Pz.jpg",51497],["Horrible Bosses",2011,2.5,1,"Seth Gordon","Comedy, Crime","uQkUwgyFHAm0jGQERPG6Z9o9Zbj.jpg",51540],["The Secret World of Arrietty",2010,3,1,"Hiromasa Yonebayashi","Fantasy, Animation, Family","3lSRaSjDp2nkXMQkzzjpRi3035O.jpg",51739],["Cria!",1976,5,2,"Carlos Saura","Drama","hueMt6pkaV8nwVGwKP2uuiqF5DJ.jpg",51857],["Seven Up!",1964,3.5,1,"Paul Almond","Documentary, TV Movie","2KSbxDP4wAZBkpbW2rs6CZBZJbq.jpg",51863],["Limitless",2011,2.5,1,"Neil Burger","Thriller, Mystery, Science Fiction","kCokPP4WCQRrrAuZ7FcpIyHr8b2.jpg",51876],["Two Cars, One Night",2003,3.5,1,"Taika Waititi","Drama, Comedy","a3BkwY76IUwadgxeKByxWv5Qukf.jpg",51896],["Beat the Devil (2002)",2002,3.5,1,"Tony Scott","Comedy, Action, Fantasy, Adventure","QkWtQ5Vle4w8MzgpsLtwDpw28q.jpg",51939],["Husbands",1970,2.5,1,"John Cassavetes","Comedy, Drama","482OpzSoSeAVx7KDJlWupLNIf0r.jpg",52105],["A Cat in Paris",2010,3,1,"Jean-Loup Felicioli","Animation, Comedy","oTAC9Htd7rAZuxrmkgTMIihtqMR.jpg",52264],["El Infierno",2010,3.5,1,"Luis Estrada","Action, Crime, Western, Comedy, Drama","vry7NyLM6I0fL53H2KxCX4uAz5H.jpg",52629],["Falling in Love",1984,2.5,1,"Ulu Grosbard","Drama, Romance","c8Ti4tOwAmY6RhUxV9JsXl2W4l7.jpg",52744],["C'est la Vie",2016,3.5,1,"Ari Aster","Drama","s6AppTbM34sNB9FASwezhIyesn5.jpg",52782],["Rabbit Seasoning",1952,4,2,"Chuck Jones","Animation, Comedy","foVYnv4rV98B2DA0Znzk3Pbm0Mg.jpg",52954],["Rabbit of Seville",1950,4.5,1,"Chuck Jones","Animation, Comedy, Music","27VEl23uM1aDxR9if2Ncs8IbSmK.jpg",52971],["What's Up, Doc? (1950)",1950,3,1,"Robert McKimson","Animation, Comedy","eaEWD0hSAhjigeQxqvf14VXqyWQ.jpg",52974],["A Fistful of Fingers",1995,2,1,"Edgar Wright","Comedy, Western","twX9BoM6XpbklfvjSIX9NQmPuxT.jpg",52996],["Le Bonheur",1965,3,1,"Agnès Varda","Drama, Romance","nNW4ewpsqxEQQoHXv4PAUsFuDmd.jpg",53023],["Lessons of Darkness",1992,4,2,"Werner Herzog","War, Documentary","rSQaIbOQj6SUSOxr3BEiAmCoj1P.jpg",53200],["Duck Amuck",1953,3.5,1,"Chuck Jones","Animation, Comedy","gRZYLCncLa2mzE59qY38McDlFdN.jpg",53210],["One Froggy Evening",1955,2.5,1,"Chuck Jones","Animation, Comedy, Music","3a1IHpFVPLrohpxQiI5WV5fPmxU.jpg",53211],["What's Opera, Doc?",1957,4,1,"Chuck Jones","Animation, Comedy, Music","kkbaY8UyPbyzU3xg8CONgwW0Eid.jpg",53217],["An Occurrence at Owl Creek Bridge",1961,3.5,1,"Robert Enrico","Drama, Fantasy","4GKfYhSuOOaJKjKOpoaDJKulCA8.jpg",53218],["Mickey's Trailer",1938,3.5,1,"Ben Sharpsteen","Animation, Comedy","rbJLSZSrxp7Kw62XWAp0kG8hxhA.jpg",53219],["Rabbit Fire",1951,4,1,"Chuck Jones","Animation, Comedy","2sK0wjqW9XtBNIsK16691MDTBkh.jpg",53220],["Powers of Ten",1977,3,1,"Charles Eames","Documentary","vPfnkN2ZFeWCg19INDLCBbfYP0r.jpg",53223],["Duck! Rabbit, Duck!",1953,4,1,"Chuck Jones","Animation, Comedy, Adventure, Family","tVMl5M3nUx3Sg294ShQ6dUYprTI.jpg",53224],["The Bank",1915,3.5,1,"Charlie Chaplin","Comedy","iTYmKDq06t3ljq56MaorzVInm4Y.jpg",53410],["Shoulder Arms",1918,2.5,1,"Charlie Chaplin","Comedy, War","lxn5foteeZbDGIEfSahW4UMxnTC.jpg",53423],["This Must Be the Place",2011,3,1,"Paolo Sorrentino","Drama","7WSD4SAMGVP6BHSOzDGL9Acunxd.jpg",53487],["Steamboat Willie",1928,3,1,"Walt Disney","Animation, Comedy","ybR0RzVkF9OLEsQHfYMDVgjrmH8.jpg",53565],["Star Trek Into Darkness",2013,2.5,1,"J.J. Abrams","Action, Adventure, Science Fiction","Aim3kVNh1MPIxPEFeJrl9e9Uf1a.jpg",54138],["Pitfall",1962,3,1,"Hiroshi Teshigahara","Mystery, Fantasy, Crime","KIRFXDuELVg86zDqDH0ESd9QoV.jpg",54146],["Revival of Evangelion",1998,3.5,1,"Hideaki Anno","Action, Animation, Drama, Science Fiction","gQx6E4roKZ7UAAKCYDMDNdYdMeo.jpg",54270],["The Water Horse",2007,2,1,"Jay Russell","Family, Adventure, Fantasy","h9DV6KItNutJmrPzT1xrAO6fIzy.jpg",54318],["April Captains",2000,3,1,"Maria de Medeiros","Drama, History","lUX2F3tyw2pa7l3snGCsnEIZHcv.jpg",54380],["La Pointe Courte",1955,3,1,"Agnès Varda","Drama, Romance","jPT3tkTu9U7oXkLTSpkPBAr5dwO.jpg",54436],["Fiancés on the Bridge",1962,3.5,1,"Agnès Varda","Comedy, Romance","hxz3xHtDoV5K4UJA5x8HNnSTtN0.jpg",54464],["Donald Duck and the Gorilla",1944,3.5,1,"Jack King","Animation, Comedy","ffpYDYXvOy93MLkdIoOXDwRu1W5.jpg",54482],["Beverly Hills Chihuahua 2",2011,0.5,1,"Alex Zamm","Comedy, Family","k3IHj3utp8m0X1KpNHyfOIsypE1.jpg",54540],["Mondays in the Sun",2002,4,1,"Fernando León de Aranoa","Drama, Comedy","4BlI5weSiYUU1YnjqdaPLnOzc3Z.jpg",54580],["Public Speaking",2010,3,1,"Martin Scorsese","Documentary","9vEqQpndZuydRbYueABgIMw34gH.jpg",54793],["Creature Comforts",1989,4,1,"Nick Park","Animation, Comedy, Family","Ap8XavPP8AyvW9TDQDAZzEGT200.jpg",54825],["Tokyo Twilight",1957,3,1,"Yasujirō Ozu","Drama","o0jpAoS01fMQDccZGS97piaNnSS.jpg",55192],["Rugrats: All Growed Up",2001,2,1,"Anthony Bell","Family, TV Movie, Comedy, Animation","rTDny0lgKKUTqgmfGXmnmV8K8uv.jpg",55289],["Alvin and the Chipmunks: Chipwrecked",2011,0.5,1,"Mike Mitchell","Comedy, Fantasy, Family, Music, Animation","npOXWVoZyl8UrF2wtByHtfmsWSX.jpg",55301],["Beginners",2010,3,1,"Mike Mills","Drama, Romance, Comedy","mAquHAmoBgZ1omUNdNsnGVNX74c.jpg",55347],["Saint Clara",1996,2.5,1,"Ari Folman","Fantasy, Science Fiction, Drama, Romance","hbcqyb5tbq4lLD3es4PKiSuUD8U.jpg",55394],["Another Earth",2011,3.5,1,"Mike Cahill","Drama, Science Fiction","qvGJK3lFzpifAdyIupMNdWNX0qr.jpg",55420],["Early to Bed",1941,2.5,1,"Jack King","Animation, Comedy","6TGFVW7s2GUSZrLalSKecYod0YA.jpg",55557],["Saraband",2003,3.5,1,"Ingmar Bergman","TV Movie, Drama","8Lt35scCMOh3HhnG81Ndc6dhazA.jpg",55650],["Bridesmaids",2011,3,1,"Paul Feig","Comedy, Romance","gJtA7hYsBMQ7EM3sPBMUdBfU7a0.jpg",55721],["The Animatrix",2003,3.5,1,"MANY","Animation, Science Fiction","g52SOsTvdjzY8oPIn5znLJMzLHG.jpg",55931],["I Know Where I'm Going!",1945,3.5,1,"Michael Powell & Emeric Pressburger","Romance, Drama, Comedy","i0Tq9xHqjlm3TjMYAJEq3hFnpQb.jpg",56137],["Bottle Rocket (1993)",1993,2.5,1,"Wes Anderson","Comedy, Crime","6RU227m20neBsRS8WMNuO1BCFn8.jpg",56149],["Mission: Impossible – Ghost Protocol",2011,3.5,1,"Brad Bird","Action, Thriller, Adventure","eRZTGx7GsiKqPch96k27LK005ZL.jpg",56292],["Palombella rossa",1989,3,1,"Nanni Moretti","Comedy, Drama","kk8Xv0j7m3CGrSRPoIEitxtEP3N.jpg",56521],["Rescue Squad Mater",2008,2,1,"John Lasseter","Animation, Family, Comedy","2mLBoPMSXshWjknql6dxc2DAfZ1.jpg",56553],["Post Mortem",2010,2.5,1,"Pablo Larraín","Drama","efB156IOsphoVkTYr3U9YpiYopJ.jpg",56815],["Dexter's Laboratory: Ego Trip",1999,3.5,1,"Genndy Tartakovsky","Animation, Comedy, Family, Science Fiction, TV Movie, Action, Drama","oiul6dw0tOkPW6EMPsZyLnvTqzA.jpg",56828],["Meek's Cutoff",2010,3.5,1,"Kelly Reichardt","Western, History, Drama","oc28NmVqLx0x8epu3Ih3LvX4zE9.jpg",57120],["Young Adult",2011,3.5,1,"Jason Reitman","Comedy, Drama","4tGMz5xUs9sk8X9B28G6UalHK1d.jpg",57157],["The Hobbit: The Desolation of Smaug",2013,3,1,"Peter Jackson","Fantasy, Adventure, Action","xQYiXsheRCDBA39DOrmaw1aSpbk.jpg",57158],["War Horse",2011,2.5,1,"Steven Spielberg","War, History, Drama","3aRHhvvngFPJFy5uAjo7GVr3PhL.jpg",57212],["Pina",2011,2.5,1,"Wim Wenders","Documentary","mKKtIJYtaGwcgpMfnVR2byYhfz9.jpg",57276],["Ice Age: Continental Drift",2012,1.5,1,"Steve Martino","Animation, Comedy, Adventure, Family","dfp1BZF7FxbBUyzHvMOI9t8NWDD.jpg",57800],["RED EYES",2010,3.5,1,"Juan Ignacio Sabatini","Documentary","h5bvECUq7ViHthpHJOOl8jHuoL0.jpg",57887],["Little Dieter Needs to Fly",1997,3.5,1,"Werner Herzog","Documentary","2sLpyYytu0Dbymzs3skxOCRHKkl.jpg",57976],["Moon of Avellaneda",2004,3.5,1,"Juan José Campanella","Drama, Romance","vyGtvy3TCMzULGznJwXUJ4tGxUT.jpg",57977],["Meantime",1983,3,1,"Mike Leigh","Drama, Comedy, TV Movie","aYeCvrkgUCylSQwmMFcqXV27WvD.jpg",57978],["The Phantom Carriage",1921,3.5,1,"Victor Sjöström","Drama, Fantasy, Horror","vmhMEj2d8JnKS5jzqJf4kYypKWN.jpg",58129],["Mr. Popper's Penguins",2011,1,1,"Mark Waters","Comedy, Family","",58224],["Daddy Longlegs",2009,3.5,1,"Josh Safdie & Benny Safdie","Drama, Comedy","lnHRAJ5ucoIXDRCVxfdABpK60OS.jpg",58251],["La Ciénaga",2001,4,1,"Lucrecia Martel","Drama","fcgRKfCRudyWggyHIT9LOPgU3qW.jpg",58429],["Senna",2010,4.5,1,"Asif Kapadia","Documentary","nZbLCbRoP6iJq5sr8daHQzjnzFh.jpg",58496],["The Butterfly Circus",2009,3,1,"Joshua Weigel","Drama","eQUQbZ4HjlSEUaKUtOvbOpz2Zl3.jpg",58500],["Sherlock Holmes: A Game of Shadows",2011,3,2,"Guy Ritchie","Action, Adventure, Mystery","vskIKrMNUAhns05dx8WYBQfcJEs.jpg",58574],["Mikey and Nicky",1976,4,1,"Elaine May","Crime, Drama","fnHC1OJ1EbdOX97nmXVYrXFgiQT.jpg",59143],["Midnight in Paris",2011,4,1,"Woody Allen","Fantasy, Comedy, Romance","4wBG5kbfagTQclETblPRRGihk0I.jpg",59436],["Warrior",2011,3,1,"Gavin O'Connor","Drama, Action","iM8n4nZJPR2abpnyZ36FUgHiRjr.jpg",59440],["August 32nd on Earth",1998,3,1,"Denis Villeneuve","Romance, Drama","iE0XpMkBOGgqYZ2UsS6bqtjvfLG.jpg",59482],["Cave of Forgotten Dreams",2010,3,1,"Werner Herzog","Documentary","7qBfQ2x3FnbB7uRaHQOBjfWFBpc.jpg",59490],["Attack the Block",2011,2.5,1,"Joe Cornish","Action, Comedy, Science Fiction","wzCMnA6NDruLzgWeqMcLPDrGAdF.jpg",59678],["Kick-Ass 2",2013,2,1,"Jeff Wadlow","Action, Adventure, Crime","1go2A3gdQjaMuHWquybgoJlQRcX.jpg",59859],["Monte Carlo",2011,1.5,1,"Thomas Bezucha","Adventure, Comedy, Romance","dcbqyycrWA56HXq5lm41HYuED8Y.jpg",59860],["Abduction",2011,1,1,"John Singleton","Thriller, Action, Mystery","d0TIDrwnMFVjg2EO4LsXQn1mbbc.jpg",59965],["Looper",2012,3.5,1,"Rian Johnson","Action, Thriller, Science Fiction","sNjL6SqErDBE8OUZlrDLkexfsCj.jpg",59967],["A Separation",2011,4.5,1,"Asghar Farhadi","Drama","wQVvASmpm8jGhJBQU20OkoMcNzi.jpg",60243],["Moneyball",2011,4,1,"Bennett Miller","Drama","4yIQq1e6iOcaZ5rLDG3lZBP3j7a.jpg",60308],["Radiohead: In Rainbows - From the Basement",2008,4,1,"David Barnard","Music","8kCR3lABdmYQDkyCa1Zh8GOivQs.jpg",60399],["Like Crazy",2011,3.5,1,"Drake Doremus","Drama, Romance","8eIhNKnRfayRwWChx0atZh4vGua.jpg",60420],["Le Bal",1983,3,1,"Ettore Scola","Music, Comedy, Drama","cAWB2CFtLg2cKYlQqbaHPEA2vBF.jpg",60612],["A Sense of History",1992,4,1,"Mike Leigh","Drama, Comedy","clpYdBOWCTWYYOnndKIu6SbD7my.jpg",61120],["The Children Are Watching Us",1943,3.5,1,"Vittorio De Sica","Drama","vEkp2FoxUFpCGeioWdUS4wb7ezh.jpg",61461],["Pale Flower",1964,3.5,1,"Masahiro Shinoda","Crime, Romance","xEB48waFBIx4WEySuOpk1vOFZ6E.jpg",61475],["Wendy Wu: Homecoming Warrior",2006,1.5,1,"John Laing","Family, Action, Adventure, TV Movie, Comedy","5E5qT8Q3pLDurJZqrO8meYZc60g.jpg",61717],["Bad Day to Go Fishing",2009,3,1,"Álvaro Brechner","Drama, Comedy, Thriller","lQJCrr6ypVgHdCQYI9BBPq2GHvN.jpg",61718],["Rise of the Planet of the Apes",2011,3.5,1,"Rupert Wyatt","Thriller, Action, Drama, Science Fiction","oqA45qMyyo1TtrnVEBKxqmTPhbN.jpg",61791],["Three Steps Above Heaven",2010,1,1,"Fernando González Molina","Romance, Drama","xeWyY2s13dRlKOLk4E3TkXgM4sS.jpg",61979],["Brave",2012,2.5,1,"Mark Andrews","Adventure, Animation, Family, Fantasy","1XAuDtMWpL0sYSFK0R6EZate2Ux.jpg",62177],["Monsters University",2013,2.5,1,"Dan Scanlon","Animation, Family, Comedy, Fantasy","y7thwJ7z5Bplv6vwl6RI0yteaDD.jpg",62211],["Dark Shadows",2012,1.5,1,"Tim Burton","Comedy, Fantasy","fd9Ck4cxVlmtXsbeGtQW7WFuUFI.jpg",62213],["Frankenweenie",2012,3.5,1,"Tim Burton","Animation, Comedy, Family","yGjVbLVdZRBlZTTQVBsj2KUjL1s.jpg",62214],["Melancholia",2011,4,1,"Lars von Trier","Drama, Science Fiction","fMneszMiQuTKY8JUXrGGB5vwqJf.jpg",62215],["Mirror Mirror",2012,3,1,"Tarsem Singh","Adventure, Comedy, Family, Fantasy","eN4t5f3GdqEGVfC2XdEvBioSZKF.jpg",62764],["Fight for Your Right Revisited",2011,2.5,1,"Adam Yauch","Music, Comedy, Science Fiction","txbWkBtDc5fXqOaUdDgty4ouzfJ.jpg",62934],["25 Watts",2001,3.5,1,"Juan Pablo Rebella & Pablo Stoll","Comedy, Drama","agNqkre8kYfCLaFb38NhXdmPiMv.jpg",63066],["The Skin I Live In",2011,4,1,"Pedro Almodóvar","Drama, Horror, Mystery, Thriller","xa7uCwGYykrf8MMI8iF5dZvNlrG.jpg",63311],["One Sings, the Other Doesn't",1977,4,1,"Agnès Varda","Drama, Music","b3YTxT8LM1AWeWyrAXd3b0kjjzz.jpg",63318],["The Kid with a Bike",2011,4,1,"Jean-Pierre Dardenne & Luc Dardenne","Drama","5uRiWyYSAYYScTRe9HP7BHpOQvr.jpg",63831],["Mauvais Sang",1986,4,1,"Leos Carax","Drama, Romance, Crime","yjUmAFx8Z3E0K1IUpQSyUilL5P9.jpg",64131],["The Muppets",2011,2.5,1,"James Bobin","Comedy, Family, Music, Adventure","mOB0Hdm23NslPNDkZC9eueatW3b.jpg",64328],["The Great Gatsby",2013,2.5,1,"Baz Luhrmann","Drama, Romance","nimh1rrDDLhgpG8XAYoUZXHYwb6.jpg",64682],["Extremely Loud & Incredibly Close",2011,1.5,1,"Stephen Daldry","Drama","6pszViNvKr1r31pP7gJNYDHEx5P.jpg",64685],["21 Jump Street",2012,3,1,"Phil Lord & Christopher Miller","Action, Comedy, Crime","8v3Sqv9UcIUC4ebmpKWROqPBINZ.jpg",64688],["Killing Them Softly",2012,2.5,1,"Andrew Dominik","Crime, Thriller","heaz45kpFa4Oa7iLis0OBas68ls.jpg",64689],["Drive",2011,4.5,1,"Nicolas Winding Refn","Drama, Thriller, Crime","602vevIURmpDfzbnv5Ubi6wIkQm.jpg",64690],["The Thrifty Pig",1941,2.5,1,"Ford Beebe","Animation","zNQgGczJINKSJTY1SVeu0uobEA0.jpg",64704],["Long-Haired Hare",1949,4.5,1,"Chuck Jones","Animation, Comedy","2d0PCqbNnaeF8ivonyovzWERXRZ.jpg",64711],["Take Shelter",2011,4.5,1,"Jeff Nichols","Thriller, Drama, Horror","dldIX0q5jewe8rSyCh8d5I1RYx3.jpg",64720],["The Tale of the White Serpent",1958,2.5,1,"Taiji Yabushita","Animation, Fantasy","iB3xcNkP2kLN6d6elvZbhw4lAf0.jpg",64777],["Monsieur René Magritte",1978,2.5,1,"Adrian Maben","Documentary","zMkLlNkrrB8HzvOvRDDNfUbTvPu.jpg",64844],["Belladonna of Sadness",1973,4,1,"Eiichi Yamamoto","Animation, Drama, Fantasy","2okYZVVw7RdMwlOKcAJsQ7Nsrpr.jpg",64847],["The Descendants",2011,3.5,1,"Alexander Payne","Comedy, Drama","8cDq5UlOPYeKm39okALCEOsZPxk.jpg",65057],["The Rite",1969,3,1,"Ingmar Bergman","TV Movie, Drama","6rlNfkvnDbxtoDpKGxFmbJgWpfE.jpg",65092],["Tomboy",2011,3.5,1,"Céline Sciamma","Drama","plEV1Q5u5caYASlG3pq3ON7acN7.jpg",65229],["Love and Anarchy",1973,3,1,"Lina Wertmüller","Romance, Drama, Comedy","90kJjNNAXIy1GCYQRbv2wrwdbPy.jpg",65332],["When We Were Kings",1996,3.5,1,"Leon Gast","Drama","cuLuhX3UhgUBO7acNsBx8W0tzZv.jpg",65608],["A Letter to Elia",2010,4,1,"Martin Scorsese","Documentary","nScIIrStFjkXzhlVaLFBIP0qZPC.jpg",65673],["The Girl with the Dragon Tattoo",2011,4,1,"David Fincher","Thriller, Crime, Mystery","8bokS83zGdhaXgN9tjidUKmAftW.jpg",65754],["Happy Feet Two",2011,2,1,"George Miller","Animation, Comedy, Family","2gWiQ4mn85jcXtREVePlVViupeV.jpg",65759],["Drunken Master II",1994,2.5,1,"Lau Kar-Leung","Action, Comedy","gGJECMJTUBU9OWBFBdy9oUbL60Y.jpg",66018],["Duck Dodgers in the 24½th Century",1953,3,1,"Chuck Jones","Animation, Comedy, Science Fiction","zrOilMBOmb68nf6NY8AkVLizkA9.jpg",67409],["Incoherence",1994,4,1,"Bong Joon Ho","Comedy, Drama","A8D7xLxLlr1HtvuLgEVSvG0sLdT.jpg",67415],["The Band Concert",1935,3.5,1,"Clyde Geronimi, Wilfred Jackson y Hamilton Luske","Animation, Comedy, Music","veEJ9AjgdcuGT9Yylvw2xdcJlUa.jpg",67572],["Three Blind Mouseketeers",1936,2.5,1,"David Hand","Animation, Family, Comedy","oqh31E3VVFUVRZiUdoxajWj57qT.jpg",67609],["Black God, White Devil",1964,4,1,"Glauber Rocha","Adventure, Western, Drama","keNDV8nbgVLiCUyzObisEDxdAI4.jpg",67612],["Think Like a Man",2012,2,1,"Tim Story","Comedy, Romance","kfIrKVPDzXJDBzPnFEuoatlaZPW.jpg",67660],["Trick or Treat",1952,3,1,"Jack Hannah","Animation, Comedy","i4HCyLpbJo3O1OvB116a6gKl3in.jpg",67699],["Popeye the Sailor Meets Sindbad the Sailor",1936,3,1,"Dave Fleischer","Animation, Adventure, Comedy, Family","Ae4r3014zCLSbaL9PiiFm9QGWXS.jpg",67713],["Chinese Take-Away",2011,3,1,"Sebastián Borensztein","Comedy","wSrMT1YrcMH4NdzH7IdJaQzgzJc.jpg",67884],["Coffee and Cigarettes (1987)",1987,3,1,"Jim Jarmusch","Comedy","ndGeSVCT1yLl1Mbcvx0yxJPcx6p.jpg",68540],["Couch",2003,1.5,1,"Paul Thomas Anderson","Comedy","lNJ91ZPm51oIc4kH9rtA8rxEyw.jpg",68568],["Django Unchained",2012,4,2,"Quentin Tarantino","Drama, Western","7oWY8VDWW7thTzWh3OKYRkWUlD5.jpg",68718],["Iron Man 3",2013,3,1,"Shane Black","Action, Adventure, Science Fiction","qhPtAc1TKbMPqNvcdXSOn9Bn7hZ.jpg",68721],["The Master",2012,5,2,"Paul Thomas Anderson","Drama","rUSjbyvYWN9H4az8xt0tDtU7I6v.jpg",68722],["Elysium",2013,2.5,1,"Neill Blomkamp","Science Fiction, Action, Drama, Thriller","aRjuJuPXHtVs6YegfeeQWXGRs1E.jpg",68724],["Pacific Rim",2013,3,1,"Guillermo del Toro","Action, Science Fiction, Adventure","8wo4eN8dWKaKlxhSvBz19uvj8gA.jpg",68726],["Silence",2016,4.5,1,"Martin Scorsese","Drama, History","x5T0cQDYws0xRBVG4Q3wpcrcmax.jpg",68730],["Argo",2012,2.5,1,"Ben Affleck","Drama, Thriller","m5gPWFZFIp4UJFABgWyLkbXv8GX.jpg",68734],["Warcraft",2016,2,1,"Duncan Jones","Action, Adventure, Fantasy","eGi5aoxaZveqNLtE7BZJCuWwR3G.jpg",68735],["The Ice Storm",1997,4,1,"Ang Lee","Drama","3a6uLta7K8Dzojps4RoJAPHD0km.jpg",68924],["Written on the Wind",1956,3,1,"Douglas Sirk","Drama, Romance","paeBU70fHsFAOooWM5V35q562f2.jpg",69605],["The Wagoner",1963,3,1,"Ousmane Sembène","Drama","dZv1eXYJAfys02TtdilGRRtMS7X.jpg",69909],["My Dad Is 100 Years Old",2005,2.5,1,"Guy Maddin","Documentary, Drama, Comedy","oMidRKsDSoaC7kTS54jIHmIBoqP.jpg",69913],["Uncle",1997,3,1,"Adam Elliot","Animation, Drama","awTtnxcLolGB4NuVKxyPPLRPyAq.jpg",69919],["The Hunger Games",2012,2.5,1,"Gary Ross","Science Fiction, Adventure, Action, Thriller","yXCbOiVDCxO71zI7cuwBRXdftq8.jpg",70160],["Winter",1988,2,1,"Arthur Penn","Horror, Thriller","t98G6rq7UpGGiFdURecUDCiBqaT.jpg",70199],["Las alturas de Macchu Picchu",1981,4.5,1,"Reynaldo Sepúlveda","Music","61A04PKSCisXvMX88YLBgEL6Row.jpg",70508],["Dante's Inferno",1911,2.5,1,"Giuseppe de Liguoro","Fantasy, Horror","ky0z9hDlajlwL3fBqwsCSbjJGjR.jpg",70512],["Huacho",2009,3.5,1,"Alejandro Fernández Almendras","Drama","376BXSjSWXxIxAzX5QEP9lmHsqY.jpg",70747],["Prometheus",2012,3,1,"Ridley Scott","Science Fiction, Mystery, Horror","qsYQflQhOuhDpQ0W2aOcwqgDAeI.jpg",70981],["The Iron Lady",2011,2,1,"Phyllida Lloyd","History, Drama","fx7wpKXOht7WOkeOslvErbrf69Q.jpg",71688],["Mistress",1992,2.5,1,"Barry Primus","Comedy, Drama","kNo9Tj7EPOkRyEJZu98RjAbQPrb.jpg",71825],["We Need to Talk About Kevin",2011,4,1,"Lynne Ramsay","Drama, Thriller","auAmiRmbBQ5QIYGpWgcGBoBQY3b.jpg",71859],["Tanner Hall",2009,2,1,"Tatiana von Fürstenberg","Drama","qoGtVlqaFWngUXuUzAS6uuNcwsI.jpg",71866],["Jack and Jill",2011,0.5,1,"Dennis Dugan","Comedy, Family","kFeAxmZvu0TE4iuLRHQD6Cej8Wf.jpg",71880],["Ted",2012,2.5,1,"Seth MacFarlane","Comedy, Fantasy","1QVZXQQHCEIj8lyUhdBYd2qOYtq.jpg",72105],["Carnage",2011,3,1,"Roman Polanski","Comedy, Drama","3Imx53XV3T02ADlMxYazYXVNysZ.jpg",72113],["World War Z",2013,2,1,"Marc Forster","Action, Horror, Science Fiction","aCnVdvExw6UWSeQfr0tUH3jr4qG.jpg",72190],["The Fox and the Hare",1973,3.5,1,"Yuri Norstein","Animation, Family","dXg2MMfudPHpzM1A4M9t4gyDsmK.jpg",72205],["The Snow Queen",1957,3.5,1,"Lev Atamanov","Animation, Family, Fantasy","ptCK2qAyGEmQBys3cImY6o6qAyp.jpg",72214],["The Last Wave",1977,4,1,"Peter Weir","Drama, Mystery, Horror","7UwdJ0EMXirUuNFaohfK023Nuyr.jpg",72277],["Safe (2012)",2012,2,1,"Boaz Yakin","Action, Crime, Thriller","kOCpkoMUVae9UIf85gO71SyjLbW.jpg",72387],["Journey 2: The Mysterious Island",2012,1,1,"Brad Peyton","Adventure, Action, Science Fiction","uFm2vnp9LhHx5MNo1Ego6O3vUhl.jpg",72545],["Salvador Allende",2004,3,1,"Patricio Guzmán","Documentary","lWYAhfpsQMxiuSQ0FBIL9HkEj6J.jpg",72553],["The Old Mill",1937,4,1,"Clyde Geronimi, Wilfred Jackson y Hamilton Luske","Animation, Thriller, Family, Music, Horror","8QaEKadFgt9R0XISXAoUvAtcQHA.jpg",72640],["Nostalgia for the Light",2010,5,1,"Patricio Guzmán","Documentary","j8NsCokx3dveFDL1YAvJPWHkrDx.jpg",72721],["Jackal of Nahueltoro",1969,4,1,"Miguel Littín","Drama, Thriller","tjcWfo5AJgU7TIyG5TFTpVhgS0t.jpg",72855],["Lincoln",2012,3,1,"Steven Spielberg","History, Drama","5KeUqW6DpVtf8G9VMuI2l0XIPCo.jpg",72976],["Le Havre",2011,3.5,1,"Aki Kaurismäki","Drama, Comedy","zCoGiKr8hn9fPYnxECjUhpaP8TI.jpg",73532],["Killer Joe",2011,4,1,"William Friedkin","Crime, Thriller, Drama","6Tt1TQeOI4TpXu1cBUgNGNGeznW.jpg",73567],["Valparaiso My Love",1969,3.5,1,"Aldo Francia","Drama","eRQdn5ciZlAR488vZchXxx7GQjp.jpg",73858],["We Bought a Zoo",2011,2,1,"Cameron Crowe","Drama, Comedy, Family","dcOvIqdsojUdAtWt1nPT9xS76Su.jpg",74465],["The Artist",2011,4,1,"Michel Hazanavicius","Drama, Comedy, Romance","z68py0ZqPgeacGPG54AGVRbNBS7.jpg",74643],["The Star Wars Holiday Special",1978,0.5,1,"Steve Binder","Adventure, Science Fiction, Family, TV Movie","lGJDx7RCgyMMa3owtp150umMnnJ.jpg",74849],["Fast and Furry-ous",1949,3.5,1,"Chuck Jones","Animation, Comedy","XinMQ1x8kejVMDl5AAKULonOCB.jpg",74961],["Oslo, August 31st",2011,4.5,1,"Joachim Trier","Drama","3IJZ252ecJICOShQgymHk7AOVIs.jpg",75233],["Scenes from the Suburbs",2011,3.5,1,"Spike Jonze","Drama, Music","jNuNlM4Pwp5Uc23GJ5hj2JLd3io.jpg",75282],["Oblivion",2013,2.5,1,"Joseph Kosinski","Action, Science Fiction, Adventure, Mystery","bYLM3GpNUZnoFElPXp1zlhDPdtv.jpg",75612],["Evangelion: 3.0 You Can (Not) Redo",2012,2.5,2,"Hideaki Anno","Animation, Science Fiction, Action, Drama","d0s1xvykzl0kz7fP5S2ROYqphdz.jpg",75629],["Now You See Me",2013,1.5,1,"Louis Leterrier","Thriller, Crime","tWsNYbrqy1p1w6K9zRk0mSchztT.jpg",75656],["My Week with Marilyn",2011,3,1,"Simon Curtis","Drama, Romance","5naqXRY1Zug5cyJJbO9H4DOg28q.jpg",75900],["Shame",2011,4.5,1,"Steve McQueen","Drama","krrOuyeyopTnqHIVBbcq74qlKkr.jpg",76025],["The Wolverine",2013,2.5,1,"James Mangold","Action, Science Fiction, Adventure","t2wVAcoRlKvEIVSbiYDb8d0QqqS.jpg",76170],["12 Years a Slave",2013,4,1,"Steve McQueen","Drama, History","xdANQijuNrJaw1HA61rDccME4Tm.jpg",76203],["Thor: The Dark World",2013,1.5,1,"Alan Taylor","Action, Adventure, Fantasy","wp6OxE4poJ4G7c0U2ZIXasTSMR7.jpg",76338],["Mad Max: Fury Road",2015,5,4,"George Miller","Action, Adventure, Science Fiction","hA2ple9q4qnwxp3hKVNhroipsir.jpg",76341],["The Devil Inside",2012,0.5,1,"William Brent Bell","Horror, Thriller","mtyFRIRBmrCE2XKU5EnEK8dtu2X.jpg",76487],["Hotel Transylvania",2012,2,1,"Genndy Tartakovsky","Animation, Comedy, Family, Fantasy","eJGvzGrsfe2sqTUPv5IwLWXjVuR.jpg",76492],["The Dictator",2012,2,1,"Larry Charles","Comedy","n0W7kajF4GFMRk2c0wWwMQqTaDM.jpg",76493],["Avatar: The Way of Water",2022,3.5,1,"James Cameron","Action, Adventure, Science Fiction","t6HIqrRAclMCA60NsSmeqe9RmNV.jpg",76600],["Chronicle",2012,3,1,"Josh Trank","Science Fiction, Drama, Thriller","kdyrdFIt29FUmLIKvedAc2j4rpo.jpg",76726],["Jupiter Ascending",2015,1.5,1,"Lilly & Lana Wachowski","Science Fiction, Fantasy, Action","2NCcAZ3M3F0FxENYmammBknwpVn.jpg",76757],["End of Watch",2012,3,1,"David Ayer","Crime, Drama, Thriller","pDeVKQICkcdwwjHxGj0MeS14YJ6.jpg",77016],["The Haunted House (1929)",1929,3,1,"Walt Disney","Animation, Comedy, Horror","vFnfcyDbFhAPjqBSwqoEi2ajScq.jpg",77022],["The Intouchables",2011,3,1,"Olivier Nakache","Drama, Comedy","1QU7HKgsQbGpzsJbJK4pAVQV9F5.jpg",77338],["Into the Abyss",2011,4.5,1,"Werner Herzog","Documentary, Crime","omYLK5w7N5YeWi4gFcNTylgvL8j.jpg",77365],["Soda Stereo: The Last Concert",2005,4,1,"Alfredo Lois","Music, Documentary","ofrU07qS7BokNaf64TRmkil6xHu.jpg",77591],["Killing Season",2013,1.5,1,"Mark Steven Johnson","Action, Thriller","o55HXx21PqRcOgAaOWFz4tGMrZh.jpg",77663],["Touki Bouki",1973,3.5,1,"Djibril Diop Mambéty","Drama, Romance","kcBYKHyg9GcQqa6DWq0AuQDhtPI.jpg",77771],["Of Love and Other Demons",2009,2,1,"Hilda Hidalgo","Drama","pmjiwwfT7kRJQ0ATi79upBmSOO9.jpg",77855],["Only God Forgives",2013,2.5,1,"Nicolas Winding Refn","Drama, Thriller, Crime","kWjjFSng1JttmDRwDROoGcIArEh.jpg",77987],["On Probation",2005,4,1,"Damián Szifron","Mystery, Crime, Action, Drama, Thriller","ZZ00teEWJMPEAqSYJ6xIxNTu4q.jpg",78237],["Twixt",2011,1.5,1,"Francis Ford Coppola","Mystery, Fantasy, Horror","jSn7DVovIFeTSiwwoziSYpJFaaS.jpg",78381],["Terrorizers",1986,3.5,1,"Edward Yang","Drama, Crime, Mystery, Thriller","7uX1PVn9Tob81hqwdzAjqPeaXZO.jpg",78450],["Night Fishing",2011,3,1,"Park Chan-wook","Drama","6gEf3315fJEqYXpdWlJ9WpLTWUQ.jpg",79392],["Valparaiso",1963,3,1,"Joris Ivens","Documentary","meaV1OEdBgFt0iQ3NVoGr9mv1cN.jpg",79423],["On the Edge",2001,3,1,"John Carney","Drama, Romance","p7UivdoGp8Zkohy8wVzQEWR3gUx.jpg",80070],["The Impossible",2012,2.5,1,"J. A. Bayona","Drama, Thriller, History","k0DLCiDbnYywOHiISALbl2EH2NE.jpg",80278],["Madagascar 3: Europe's Most Wanted",2012,2.5,1,"Eric Darnell & Tom McGrath","Animation, Family, Comedy, Adventure","ekraj4ksvIKeuvQVEevEJkuybZd.jpg",80321],["Wanda",1970,3,1,"Barbara Loden","Drama, Crime","izuJ7cUhcihFnTpfsdSnkMCHsRQ.jpg",80560],["Violeta Went to Heaven",2011,4,1,"Andrés Wood","Drama, Music","lE3N29dnqqiIcKKdvAZpVcQZ9b.jpg",80717],["Rise of the Guardians",2012,3,1,"Peter Ramsey","Action, Adventure, Animation, Family, Fantasy","yfzmfWGjcmyugH6FZ13WcsUGiNj.jpg",81188],["Rudolph the Red-Nosed Reindeer",1948,2.5,1,"Max Fleischer","Animation, Family, Fantasy","sDxEaJoFRHcI7kdDE5c8WSMofPi.jpg",81294],["Supermarket Woman",1996,4,1,"Jūzō Itami","Comedy, Drama","3AAnuWvvPMCDZpJEiDN80foOFYJ.jpg",81296],["Good Luck Charlie, It's Christmas!",2011,1.5,1,"Arlene Sanford","Comedy, Family, Drama, TV Movie","ecuJMYZM3HQ96mnWtmyXoHb7s7T.jpg",81440],["A Useful Life",2010,3.5,1,"Federico Veiroj","Drama, Comedy","udTBOL4BlTZXXE1DPC3vfwsgYW7.jpg",81523],["Pioneer",2011,3,1,"David Lowery","Drama","6Q9LeTalMvF4u5zz4SStOJKShW1.jpg",81798],["To Rome with Love",2012,2.5,1,"Woody Allen","Comedy, Romance","sMmYRgvFRk5Ginhytx7ciU7UwVs.jpg",81836],["Alps",2011,3,1,"Yorgos Lanthimos","Drama","nF5A64lC0MuuEK6qNmOfQpY6mRv.jpg",81857],["The Sprinkler Sprinkled",1895,3,1,"Louis Lumière","Comedy","rSZghvrFWTGqi4UecyG9jimzpEO.jpg",82120],["Small Fry",2011,2,1,"Angus MacLane","Animation, Comedy, Family, Adventure","8siICxMft0JSWZDq9YrXh5U5PZx.jpg",82424],["Sinister",2012,3.5,1,"Scott Derrickson","Horror, Thriller, Mystery","nzx10sca3arCeYBAomHan4Q6wa1.jpg",82507],["Warm Bodies",2013,2.5,1,"Jonathan Levine","Horror, Comedy, Romance, Action, Science Fiction","i8vCO3uszvlfBJVEyuIZVUDlt60.jpg",82654],["Gangster Squad",2013,2,1,"Ruben Fleischer","Crime, Drama, Action, Thriller","wAuQNTBFBu2yXZsX6yLhUPiwTlW.jpg",82682],["Wreck-It Ralph",2012,3.5,2,"Rich Moore","Family, Animation, Comedy, Adventure","zWoIgZ7mgmPkaZjG0102BSKFIqQ.jpg",82690],["Silver Linings Playbook",2012,4,1,"David O. Russell","Drama, Comedy, Romance","y7iOVneBvITlBdhy6tVqXVOa1Js.jpg",82693],["Les Misérables",2012,3,1,"Tom Hooper","History, Drama","6CuzBs2Lb8At7qQr64mLXg2RYRb.jpg",82695],["Hope Springs",2012,2.5,1,"David Frankel","Drama, Comedy, Romance","mHEca5NntVHtUPfBiQ3ZVFBRixe.jpg",82696],["After Earth",2013,1,1,"M. Night Shyamalan","Science Fiction, Action, Adventure","iXMvYIlzzJBs352CfeiQcBvovZt.jpg",82700],["How to Train Your Dragon 2",2014,3.5,1,"Chris Sanders & Dean DeBlois","Fantasy, Action, Adventure, Animation, Family","d13Uj86LdbDLrfDoHR5aDOFYyJC.jpg",82702],["Mr. Peabody & Sherman",2014,2.5,1,"Roger Allers & Rob Minkoff","Animation, Science Fiction, Comedy, Adventure, Family","hPcImYndWESKHzT2GHVCDsUxzYg.jpg",82703],["Fast & Furious 6",2013,2.5,1,"Justin Lin","Action, Thriller, Crime","thSmnRdrzPBBospIOJjLZBReqzo.jpg",82992],["Tummy Trouble",1989,3,1,"Roger Allers & Rob Minkoff","Comedy, Animation","mLOqZNasNOUKSNCpAIeHmJWPkvW.jpg",83200],["Roller Coaster Rabbit",1990,3.5,1,"Roger Allers & Rob Minkoff","Family, Comedy, Animation","v9mNkB3htZEod4OZd3bXJd5VK7J.jpg",83202],["Trail Mix-Up",1993,3,1,"Barry Cook","Comedy, Animation","s4OSOn1sAZekhPzJrgmidXOOAUH.jpg",83203],["Cloud Atlas",2012,3.5,1,"Lilly & Lana Wachowski","Drama, Science Fiction","8naVv2Xu3rWI5JKHz0vCujx6GaJ.jpg",83542],["This Is Not a Film",2011,3.5,1,"Jafar Panahi","Documentary","qRkxx6lIOUei4PxbFWH6UfWfUib.jpg",83552],["Moonrise Kingdom",2012,4.5,2,"Wes Anderson","Comedy, Drama, Romance","y4SXcbNl6CEF2t36icuzuBioj7K.jpg",83666],["Life, and Nothing More…",1992,3,1,"Abbas Kiarostami","Drama, Adventure","100CuZjqxtcbDvZ5qPsoi1VEU5n.jpg",83761],["Feed the Kitty",1952,3.5,1,"Chuck Jones","Animation, Comedy, Family","vso5zGYGzUMsxsI4FH0Q4B1iX3X.jpg",83765],["On the Road",2012,2,1,"Walter Salles","Adventure, Drama","k7LQteD02p3VHixbS6NXHkFdFwT.jpg",83770],["I Love to Singa",1936,3.5,1,"Tex Avery","Animation, Comedy, Music","utEcqXg8f9edXJJls25trTgpSH.jpg",83797],["The Sacred Family",2005,2.5,1,"Sebastián Lelio","Drama","q9quwwH5h4C45kOQ4J7jVsMnepZ.jpg",83887],["2 Days in New York",2012,2,1,"Julie Delpy","Comedy, Drama, Romance","tK6G639JfQV36WRr9wTu1D9iZRg.jpg",84165],["Celeste & Jesse Forever",2012,3,1,"Lee Toland Krieger","Comedy, Drama, Romance","5Cr8kW7DjZEORU8jI32bqyHSGKW.jpg",84184],["Excision",2012,3.5,1,"Richard Bates Jr.","Drama, Horror, Comedy","3aLgB6FTQlNanER0RpckbKdwyh9.jpg",84194],["Searching for Sugar Man",2012,4.5,1,"Malik Bendjelloul","Music, Documentary","ucM98HuBHSWmn44oiE83hIDc6VB.jpg",84334],["Young and Wild",2012,4,1,"Marialy Rivas","Comedy, Drama","ixTyxtsK6W63jrWjixczyeJSex2.jpg",84354],["Tooth Fairy 2",2012,0.5,1,"Alex Zamm","Comedy, Family","oIkcTCUdvc5fDyG2IxdCd26hRQ7.jpg",84575],["The Dot and the Line: A Romance in Lower Mathematics",1965,3.5,1,"Chuck Jones","Animation, Family","2omBQEwNr1GrJkE4jeiqSHjSDdb.jpg",84617],["The Mad Masters",1955,3,1,"Jean Rouch","Documentary","3L6pzmvpS0Yweav4XgH0QOoufxs.jpg",84820],["The Perks of Being a Wallflower",2012,3.5,1,"Stephen Chbosky","Drama","aKCvdFFF5n80P2VdS7d8YBwbCjh.jpg",84892],["Fantasmagorie",1908,2,1,"Émile Cohl","Animation, Comedy","bDlC9FuKEZgpz9rRPNHZO22ARZD.jpg",85221],["Boyhood",2014,4,1,"Richard Linklater","Drama","2BvtvDUyxiMJ4dmKfiQf4qdOHQN.jpg",85350],["The Cure In Orange",1987,3.5,1,"Tim Pope","Music","vsEau53Z4cPa9d01zINoSq4gjmf.jpg",85565],["Broken Down Film",1985,3.5,1,"Osamu Tezuka","Romance, Animation, Comedy, Western, Action","hP0I7MQCGvHCOCyZH850eWFFann.jpg",85791],["New Year",2010,3.5,1,"Cristóbal Valenzuela","Drama, Comedy, Romance","kdlmCx8pc4dAreM6kmBxLJTtBxP.jpg",85956],["A Cab for Three",2001,3,1,"Orlando Lübbert","Drama, Crime","1mIk07uUalwivNQ6FOvmaMmHQhg.jpg",86126],["It's Such a Beautiful Day (2011)",2011,5,1,"Don Hertzfeldt","Animation, Drama, Comedy","gZIBj1iJAbz5d0pi01FZ4HJLAAq.jpg",86517],["News from Home",1976,4,1,"Chantal Akerman","Documentary","nWqWaEySdo8hAKJsd1IS9mdnZpF.jpg",86814],["Stoker",2013,4,1,"Park Chan-wook","Drama, Horror, Thriller","aK0PTgwDiLm2YCNpOrhD8JR3mqL.jpg",86825],["Absolutely Anything",2015,1.5,1,"Terry Jones","Comedy, Science Fiction","tnBt9yPCQwnXLwioqfgnL5hqGM6.jpg",86828],["Inside Llewyn Davis",2013,5,2,"Joel Coen & Ethan Coen","Drama, Music","nNxK3pC3DMpPpWKMvo2p3liREVT.jpg",86829],["Noah",2014,2,1,"Darren Aronofsky","Drama, Adventure","vVLkHabnF5lVpCpqyhZBI5iCYMA.jpg",86834],["Amour",2012,5,1,"Michael Haneke","Drama, Romance","19hyCudualHxCD0GrEngqsi0wBF.jpg",86837],["Seven Psychopaths",2012,3,1,"Martin McDonagh","Comedy, Crime","4ukEYAxlSivFcDG6vLxJB6PjTjg.jpg",86838],["Big Eyes",2014,3,2,"Tim Burton","Drama","203HAjJcLMl7xThcTqZx4zmEGcV.jpg",87093],["Terminator Genisys",2015,1,1,"Alan Taylor","Science Fiction, Action, Thriller","oZRVDpNtmHk8M1VYy1aeOWUXgbC.jpg",87101],["Foxcatcher",2014,3.5,1,"Bennett Miller","Drama, Thriller","w6Sl079QtUcQ9dVQ2RP6aN9NBXx.jpg",87492],["The Big Wedding",2013,1.5,1,"Justin Zackham","Comedy","ooSGwWVJRp81ErEH7VmTmVwjoMc.jpg",87567],["Movie 43",2013,0.5,1,"MANY","Comedy","uYa06GxHsCsELx9vOQ11vsT0Aa6.jpg",87818],["Life of Pi",2012,3.5,1,"Ang Lee","Adventure, Drama","iLgRu4hhSr6V1uManX6ukDriiSc.jpg",87827],["Poor Pierrot",1892,3,1,"Émile Reynaud","Comedy, Animation","4zucpoTtsGv7jsadNHe6g9hDc32.jpg",88013],["The Skeleton Dance",1929,4,1,"Walt Disney","Animation, Family, Music, Comedy, Horror","zYwp7SK4HRc9sf4oog3XP02dJv4.jpg",88018],["The Hypothesis of the Stolen Painting",1978,2.5,1,"Raúl Ruiz","Drama, Mystery","4PTfpEp96NccwdaFQkiq0wVkFQO.jpg",88034],["Journey to the Center of the Earth",2008,1.5,1,"Eric Brevig","Action, Science Fiction, Adventure, Comedy, Family","kL55wY0s2H9JdwfjoWIp9plvYnl.jpg",88751],["Robin Hood Daffy",1958,3.5,1,"Chuck Jones","Animation, Comedy","jlWl85dTRxjZnOOr6jD9g4u0dY6.jpg",88765],["J. Edgar",2011,2.5,1,"Clint Eastwood","Drama, Crime, History","gltciP2dIaEQmm4JeYfB088k40n.jpg",88794],["Samsara",2011,4.5,1,"Ron Fricke","Documentary","qodkea4k0pNUmNTl5TJO2PdTqgW.jpg",89708],["The Insects' Christmas",1913,3.5,1,"Władysław Starewicz","Animation, Fantasy","5CRQ3MnRKJonSw8xHoCW27g7eN3.jpg",90045],["The Cameraman's Revenge",1912,4,1,"Władysław Starewicz","Animation, Comedy","eJ8IQrSWc8wNWSySa3WoMs6np2Z.jpg",90056],["The Little Mermaid (1968)",1968,3,1,"Ivan Aksenchuk","Animation, Fantasy, Family","uG7wWSmdEssgYZxXB0L7mFJE929.jpg",90277],["The Battle of Kerzhenets",1971,3.5,1,"Yuri Norstein","Animation","f6FQO9VFp2AzhCl35zDvDOBX3ey.jpg",90327],["Crac!",1980,3.5,1,"Frédéric Back","Animation, Drama","8fgvKKoZw3Pcg4cHAgLWBsILNoM.jpg",90781],["Cipollino",1961,3,1,"Boris Dyozhkin","Animation, Family, Fantasy","aLhBO9lmwHAnmhi3jhF2fTaXxVD.jpg",91142],["Transformers: Age of Extinction",2014,0.5,1,"Michael Bay","Science Fiction, Action, Adventure","jyzrfx2WaeY60kYZpPYepSjGz4S.jpg",91314],["Kinetta",2005,1.5,1,"Yorgos Lanthimos","Drama","bjgIJAcL0HonVzvvZ2ebTN1F9SA.jpg",91410],["Italianamerican",1974,3.5,1,"Martin Scorsese","Documentary","5mznNfhBuABFctEuw2p0NHlEaZ2.jpg",91459],["The Year of the Tiger",2011,2,1,"Sebastián Lelio","Drama","1fWBVXEAkk2PoGc572Bmcb3SSam.jpg",91552],["Starlet",2012,3.5,1,"Sean Baker","Drama","8mVU5KjD5b4Df3CRTnJqKFSwg5y.jpg",91679],["Michael Jackson's Thriller",1983,4,1,"John Landis","Horror, Music, Thriller","dYHGoPMkZMVuBA4EydmDQMo1EEv.jpg",92060],["Bernie",2011,3.5,1,"Richard Linklater","Comedy, Crime, Drama","rW5CetooG545jpkPNpD4FjFAXfe.jpg",92591],["Fortune Cookie",1991,2,1,"Darren Aronofsky","Comedy","ld2twhYzKGPbTTqtlyI9jsX31PA.jpg",92655],["Lick the Star",1998,2,1,"Sofia Coppola","Drama","kyMHq9xj9CQwwCSBZpvcHg7voJ8.jpg",92657],["Despicable Me 2",2013,2,1,"Pierre Coffin & Chris Renaud","Animation, Comedy, Family, Science Fiction","5Fh4NdoEnCjCK9wLjdJ9DJNFl2b.jpg",93456],["Diagonal Symphony",1924,2.5,1,"Viking Eggeling","Animation","x2sKH9OAWCkP8PTYDOGXH6QXFGK.jpg",93521],["Tabu",2012,4,1,"Miguel Gomes","Drama, Romance","mtr1ztUkJs6jsYdzK3gBLsuffr4.jpg",93858],["The Raid",2011,3,1,"Gareth Evans","Action, Thriller, Crime","Abnm1Ws3JH0ReCfEhLMPwPcMcGO.jpg",94329],["A Page of Madness",1926,3,1,"Teinosuke Kinugasa","Horror, Drama","48lRmIBSvECIZGxKqvkWJxLaHdY.jpg",94525],["The Kiss",1896,2.5,1,"William K.L. Dickson & William Heise","Drama, Romance","sezdGOX4ykTnPNBNlcEIoleCwjG.jpg",94570],["Directed by John Ford",1971,3.5,1,"Peter Bogdanovich","Documentary","wrRthkGDhj7k1MtxNgHbKLTg6VD.jpg",94623],["Rescued by Rover",1905,3,1,"Cecil M. Hepworth","Drama","m4yuuCmJKoTo9BPpjQvz3LuRs9H.jpg",94643],["Dream of Light",1992,3.5,1,"Víctor Erice","Documentary","wH3VuGHcf0jTzeRGLZlPfqTIHS1.jpg",94706],["Diary of a Pregnant Woman",1958,2.5,1,"Agnès Varda","Documentary","nIr8T5lssXSjEGMLrdB51kqKtn8.jpg",95378],["Superman (1941)",1941,2.5,1,"Dave Fleischer","Action, Animation, Family, Adventure, Science Fiction, Fantasy","4DK6wWZTp6v32NUXszkHOPGxm16.jpg",95414],["The Full Treatment",1960,1.5,1,"Val Guest","Mystery, Thriller","5C8cZ5uOynaQEKej8tteXN5lJ3g.jpg",95467],["Black Girl",1966,4,1,"Ousmane Sembène","Drama","hYYAk9I9KkscSr8DC30KyDjzsVu.jpg",95597],["The Big Swallow",1901,3,1,"James Williamson","Comedy","xBcai37vavGLEYQ8B1TSvO6pl9m.jpg",96035],["All These Women",1964,2,1,"Ingmar Bergman","Drama, Comedy","jOOLYdOUbXL5ufuxP6Xr8llajKr.jpg",96118],["Rush",2013,3.5,1,"Ron Howard","Drama, Action","95BDrWmcfJDEa2WCfjmLgi67jhi.jpg",96721],["Anna Karenina",2012,3,1,"Joe Wright","Drama, Romance, History","2DvjkCbmlg8sbBHZKUZvYPgsT5V.jpg",96724],["The Bling Ring",2013,2.5,1,"Sofia Coppola","Drama, Crime","6yh55qCcdgPRJweDWM2CiEubJCL.jpg",96936],["Dreams",1955,3,1,"Ingmar Bergman","Drama, Romance","whdg2Oxdp8mJdiO7sIUQtwtMlnV.jpg",97211],["The Place Beyond the Pines",2012,3.5,1,"Derek Cianfrance","Drama, Crime","vY5j2xQzMGWmxBuhQo0HfA4Lxqb.jpg",97367],["Under the Skin",2013,4.5,1,"Jonathan Glazer","Thriller, Science Fiction, Drama","55wmcXJIDYITr7JDijJTdvwSaAv.jpg",97370],["Zero Dark Thirty",2012,4,1,"Kathryn Bigelow","Thriller, Drama","wNSdSSxowM3WIqmPJNg3RagYbwP.jpg",97630],["Flight of the Conchords: A Texan Odyssey",2006,3.5,1,"Jess Feast","Comedy, Music, Documentary","vZWwLOHsL6lg73uUVBysM2WVBS6.jpg",98412],["River of Grass",1994,2.5,1,"Kelly Reichardt","Drama, Crime","i2s1L8AavAfKIcKf3ONhF3no405.jpg",98514],["Werner Herzog Eats His Shoe",1980,4,1,"Les Blank","Documentary, Comedy","vUJ2HJN74q4niaaEmH74AaFE3T8.jpg",99189],["Next Floor",2008,3.5,1,"Denis Villeneuve","Comedy","1HBizk472Kb0SY8NM8XTbig2xpm.jpg",99343],["Avengers: Age of Ultron",2015,2.5,1,"Joss Whedon","Action, Adventure, Science Fiction","4ssDuvEDkSArWEdyBl2X5EHvYKU.jpg",99861],["Dumb and Dumber To",2014,1,1,"Peter Farrelly & Bobby Farrelly","Comedy","cvEi0xV7TUkabJGuzulhvbMjrHi.jpg",100042],["Gertie the Dinosaur",1914,3,1,"Winsor McCay","Animation, Comedy","fH5c2a3Nti765GqG8jj0uMBLgIK.jpg",100246],["She Was an Acrobat's Daughter",1937,2,1,"Friz Freleng","Animation, Comedy","nB1zAsYmHZAH7XC43Z1rkLfrj64.jpg",100357],["The Ducksters",1950,3,1,"Chuck Jones","Animation, Comedy","qv81X1vN1k8Q3ufSNBDPUXTbsab.jpg",100366],["Captain America: The Winter Soldier",2014,3.5,1,"Anthony Russo & Joe Russo","Action, Adventure, Science Fiction","tVFRpFw3xTedgPGqxW0AOI8Qhh0.jpg",100402],["The Hand",1965,3,1,"Jiří Trnka","Animation, Horror, Drama","83YdjKErufydzHqvJgyY5D7EUme.jpg",100592],["The Hunger Games: Catching Fire",2013,3,1,"Francis Lawrence","Adventure, Action, Science Fiction","vrQHDXjVmbYzadOXQ0UaObunoy2.jpg",101299],["Eternal Blood",2002,1.5,1,"Jorge Olguín","Horror, Fantasy, Thriller","oX5pBME2LlpU6zlHnU9qcj0FFkb.jpg",101604],["Welcome Back, Mr. McDonald",1997,4,1,"Koki Mitani","Comedy","y1bFYM4d9YFVye1Jc8vgxJUfyOR.jpg",102227],["The Amazing Spider-Man 2",2014,2,1,"Marc Webb","Action, Adventure, Science Fiction","dGjoPttcbKR5VWg1jQuNFB247KL.jpg",102382],["Maleficent",2014,2,1,"Robert Stromberg","Fantasy, Adventure, Action, Family, Romance","bDG3yei6AJlEAK3A5wN7RwFXQ7V.jpg",102651],["By the Fire",2012,2.5,1,"Alejandro Fernández Almendras","Drama","a1KcsA54ltAISzK9V5v2UiVJuLm.jpg",102853],["Ant-Man",2015,3,1,"Peyton Reed","Science Fiction, Adventure, Action","rQRnQfUl3kfp78nCWq8Ks04vnq1.jpg",102899],["Holy Motors",2012,4.5,1,"Leos Carax","Drama, Fantasy","4ZuTrrDQhCS9f6KzIX6HfsjjyMd.jpg",103328],["Ruby Sparks",2012,3.5,1,"Jonathan Dayton & Valerie Faris","Comedy, Romance, Fantasy, Drama","zELurt0GVRkR5X5ymuk7KXUxhC8.jpg",103332],["The Hunt",2012,5,1,"Thomas Vinterberg","Drama","jkixsXzRh28q3PCqFoWcf7unghT.jpg",103663],["Mud",2012,4,1,"Jeff Nichols","Drama","o2jT5jQdKh1HAF0fMKuGwBOwOYB.jpg",103731],["Racketeer Rabbit",1946,2,1,"Friz Freleng","Animation, Comedy, Crime","gYMdACNIz0uDhdGvRpJw61vi6VF.jpg",103952],["Murder",1957,2,1,"Roman Polanski","Crime, Thriller","vrjckuk5apnmJt0CLxQj2b86NgX.jpg",104144],["Pastoral: To Die in the Country",1974,2.5,1,"Shūji Terayama","Fantasy, Drama","b1PCDIYAaawE7oprjFoXweHjAiA.jpg",104251],["A Study in Choreography for Camera",1945,3,1,"Maya Deren","Music","9T4zoT4QHTicz39EOiYccqnbMEo.jpg",104378],["Darkened Room",2002,2,1,"David Lynch","Drama, Horror","1UtUgZ7FV2ReCdrrUtGUO8tJDGo.jpg",104391],["Dickson Experimental Sound Film",1894,2,1,"William K.L. Dickson & William Heise","Music","29GejylcrVahrRziYn3B1CLUs9y.jpg",104396],["Le château hanté",1897,2.5,1,"Georges Méliès","Horror","6nHr8cXcmaGMEfxzg6rcDsKTobU.jpg",104471],["After the Ball",1897,2,1,"Georges Méliès","Drama","8JGoVTgdd9I3iThR6M6gAV3bHid.jpg",104477],["The Astronomer's Dream",1898,3,1,"Georges Méliès","Fantasy, Horror, Comedy","hSboBoIJQ2APcVQYOcMSMrbrbhn.jpg",104700],["Newark Athlete",1891,2.5,1,"William K.L. Dickson & William Heise","Documentary","itnuTVUMuvlal8CxQhT1PNoH2HF.jpg",104852],["Fencing",1892,2.5,1,"William K.L. Dickson & William Heise","Documentary","ueF7XnBZhe9bjX3rdo4DhfcNnaI.jpg",105153],["Edison Kinetoscopic Record of a Sneeze",1894,2,1,"William K.L. Dickson & William Heise","Documentary","s7fhher78hv1I5tKl7NbgnwsKha.jpg",105158],["Suspense.",1913,3,1,"Phillips Smalley","Drama, Thriller, Horror","gSlKdlndjzIYwWblYSSZligMXuu.jpg",105408],["Peppermint Frappé",1967,4,1,"Carlos Saura","Drama, Thriller","vBoDIvqSU88rWLcpzNmnstc8FBV.jpg",105584],["Rhythm 21",1921,2.5,1,"Hans Richter","Animation","9ABnQLyk32sk5wgRgWTqCuXtDUv.jpg",105715],["The Good Dinosaur",2015,2.5,1,"Peter Sohn","Adventure, Animation, Family","8RSkxOO80btfKjyiC5ZiTaCHIT8.jpg",105864],["La respuesta",1961,3.5,1,"Leopoldo Castedo","Documentary","1F2Box0ZPSLdAMaG9LTbjszQufh.jpg",106057],["Taipei Story",1985,3.5,1,"Edward Yang","Drama","veJ93QUnTBX4WXk5qSl1s42Uosj.jpg",106380],["We Were Once a Fairytale",2009,2.5,1,"Spike Jonze","Drama, Fantasy","nHDPOTRlUmJUYdBufZl2Lpez6IX.jpg",106414],["The Wolf of Wall Street",2013,5,3,"Martin Scorsese","Crime, Drama, Comedy","kW9LmvYHAaS9iA0tHmZVq8hQYoq.jpg",106646],["Cigarettes & Coffee",1993,2.5,1,"Paul Thomas Anderson","Drama, Crime","gapJGcwC2aEtcYWPp7d5WosUsU0.jpg",107380],["Julio Begins in July",1979,3,1,"Silvio Caiozzi","Drama","si3tNNltgOL7XHRcbq8DZARNBG4.jpg",107426],["The Rocket from Calabuch",1956,2.5,1,"Luis García Berlanga","Comedy","ejmJiM64jy6bRnyBLSJnETvPtCv.jpg",107612],["The World's End",2013,3.5,1,"Edgar Wright","Comedy, Action, Science Fiction","kpglnOBYmKn0AkkWDzGxzKHDbds.jpg",107985],["La chambre",1972,4,2,"Chantal Akerman","Documentary","AcPjwocyAIqxkvjPOxAjWIbIDXH.jpg",109383],["This Is the End",2013,3,1,"Evan Goldberg & Seth Rogen","Action, Comedy","tNIW0NhX1hKvUsy6PQ80DOKUhkD.jpg",109414],["Side Effects",2013,3.5,1,"Steven Soderbergh","Thriller, Crime, Drama","dk10bwGyj8aRdOTl3EkgATEefh2.jpg",109421],["Captain Phillips",2013,3.5,1,"Paul Greengrass","Action, Drama, Thriller","8Td0kkocW6sD3uRpzwfMfkqMWhx.jpg",109424],["Evil Dead",2013,3.5,1,"Fede Álvarez","Horror","1gDV0Lm9y8ufIKzyf0h0GBgb9Zj.jpg",109428],["The Hangover Part III",2013,1.5,1,"Todd Phillips","Comedy","vtxuPWkdllLNLVyGjKYa267ntuH.jpg",109439],["Anchorman 2: The Legend Continues",2013,2,1,"Adam McKay","Comedy","BAdmxMdCqzjs6hx3KuEtnoWP8d.jpg",109443],["Frozen",2013,3,1,"Chris Buck","Animation, Family, Adventure, Fantasy","kgwjIb2JDHRhNk13lmSxiClFjVk.jpg",109445],["Cloudy with a Chance of Meatballs 2",2013,2.5,1,"Kris Pearn","Animation, Family, Comedy","ss5NcK2NWFg2YcKKYXLrk8q1myS.jpg",109451],["Laurence Anyways",2012,4,1,"Xavier Dolan","Drama, Romance","d8BpJ9qOQE7VFFqaV1XDdGfMsP7.jpg",110160],["No",2012,4,1,"Pablo Larraín","Drama, History","Aqp4PH27zI4Uqqag41y2gXwmXma.jpg",110398],["Snowpiercer",2013,3.5,1,"Bong Joon Ho","Action, Science Fiction, Drama","kw6YQudA0TMcNmGUGy5XIw7zbnV.jpg",110415],["Song of the Sea",2014,4,1,"Tomm Moore","Family, Animation, Fantasy","16LQC6zpqB0l74mVWb93a2oMFnX.jpg",110416],["Wolf Children",2012,4,1,"Mamoru Hosoda","Animation, Family, Drama, Fantasy","3Nllh6JgcrFdtOn6iFOWHudNInd.jpg",110420],["The Moon in the Mirror",1990,3.5,1,"Silvio Caiozzi","Drama","stxWKWvtJniR8jl5S0pv2UA8GaC.jpg",110933],["Extraordinary Stories",2008,5,1,"Mariano Llinás","Drama","mj0hS9Ekg09FsM4N5SeDSOc18sJ.jpg",111188],["Soda Stereo: Gira Me Verás Volver",2008,3.5,1,"","Music","6JgQIgFYOmm3BddZpNJZTj19TrB.jpg",111616],["Hitchcock",2012,2.5,1,"Sacha Gervasi","Drama","zlG4QzB00VM6QHUmRkKaboCOgat.jpg",112336],["Old Cats",2010,3.5,1,"Sebastián Silva","Drama, Comedy","cPdyNU9UF1QMLwMVzUxbYpuRe8Z.jpg",112555],["Lovers Rock",2020,4,1,"Steve McQueen","Documentary, Music, Family","wu4dImuKsAhI3tH5mTQ9HsShb6z.jpg",113089],["The Barn Dance",1929,2,1,"Walt Disney","Animation, Comedy","cRdC7eHdDL5ieVY7zW20iD8IWXM.jpg",113254],["The Frontier",1991,4,1,"Ricardo Larraín","Drama, Romance","7Wh2MhzjswMzliPq7lWkOG8JZ65.jpg",114092],["Cinderella (1899)",1899,2.5,1,"Georges Méliès","Drama, Family, Fantasy, Romance","j0GSDrWtlkMQ3vH6Bxjlt8KLLvA.jpg",114108],["Tunneling the English Channel",1907,2.5,1,"Georges Méliès","Adventure","myabFkyPcS6E1GexlTIGWlqy07M.jpg",114145],["Pitch Perfect",2012,2.5,1,"Jason Moore","Comedy, Music, Romance","gsFoJk9g8W3zgaipRrrURk7LbiF.jpg",114150],["The Hunt (1966)",1966,4,1,"Carlos Saura","Drama, Thriller","2lODWq6rLdcb8hLuQpt9qHSAatW.jpg",114333],["Pink Floyd - The Reunion Concert",2005,3,1,"Roger Waters","Music","3dy7w2QLIw6xjQE16F5nb8Z41yB.jpg",115101],["Enamorada",1946,2.5,1,"Emilio Fernández","Drama, Romance, War","lHKRBzPNgu0XgGiBg2U5ltSE438.jpg",115301],["Stuck in the Suburbs",2004,2,1,"Savage Steve Holland","Family, Comedy, Music, TV Movie","3iTQNq076Q7eNzUJpScDdxgQtcH.jpg",115626],["Paddington",2014,4,2,"Paul King","Comedy, Adventure, Family","wpchRGhRhvhtU083PfX2yixXtiw.jpg",116149],["Maggie Simpson in \"The Longest Daycare\"",2012,3,1,"David Silverman","Animation, Family, Comedy","6db4Dzg3GmlQxbUrJCDhcbMvMxN.jpg",116440],["The Ballad of Narayama",1958,3,1,"Keisuke Kinoshita","Drama","kwvNyyXFsVAPg9PYQsogcXj99lV.jpg",116690],["The Secret Life of Walter Mitty",2013,3.5,1,"Ben Stiller","Adventure, Comedy, Drama, Fantasy","tY6ypjKOOtujhxiSwTmvA4OZ5IE.jpg",116745],["The Death of Pinochet",2011,2,1,"Bettina Perut & Iván Osnovikoff","Documentary, History","fZQTNM0nkXoTMgscIXvUNStK0gJ.jpg",117127],["The Lifeguard",2011,3.5,1,"Maite Alberdi","Documentary","mCGSSpQw072SNuorHy4HvaKrk5F.jpg",118167],["Influenza",2004,2.5,1,"Bong Joon Ho","Comedy, Crime, Drama","eJIUhG3FrsQGkOo4KWnwb0xLKQf.jpg",118179],["Club Oscar",2005,0.5,1,"Rob Letterman","Animation, Comedy, Family","o8o3lBY3oiI8NwpzZw8nLMUH3FA.jpg",118254],["Guardians of the Galaxy",2014,4,4,"James Gunn","Action, Science Fiction, Adventure","r7vmZjiyZw9rpJMQJdXpjgiCOk9.jpg",118340],["Decalogue I",1989,4.5,1,"Krzysztof Kieślowski","Drama, TV Movie","h3kJ2UXkZSUzfQAAjcRwl6qNIpc.jpg",118662],["Decalogue III",1989,3,1,"Krzysztof Kieślowski","Drama, TV Movie, Romance","t9V2nTq15i9cmfbieglzaCW4IJk.jpg",118663],["Dekalog",1989,3.5,1,"Krzysztof Kieślowski","Drama, TV Movie, Romance","t9V2nTq15i9cmfbieglzaCW4IJk.jpg",118663],["Decalogue V",1989,4,1,"Krzysztof Kieślowski","Drama, TV Movie, Crime","tZktBR66C8WIJHJkqMlj6MgowDK.jpg",118665],["Decalogue VI",1989,3.5,1,"Krzysztof Kieślowski","Drama, TV Movie","lFrFFA3hdQrx0JaumP0mMkuM13X.jpg",118667],["Decalogue VII",1989,3.5,1,"Krzysztof Kieślowski","Drama, TV Movie","itblkmFBfKhZxUbJjYgyEgjDlgj.jpg",118668],["Decalogue IX",1989,2.5,1,"Krzysztof Kieślowski","Drama, TV Movie, Romance","9walZQzHStoe38bEJv4AJbcV56K.jpg",118669],["Decalogue X",1989,3.5,1,"Krzysztof Kieślowski","Drama, TV Movie, Comedy","7zvQpJDfpXlCe9FvBdO86hIgavN.jpg",118670],["There Will Come Soft Rains",1984,4,1,"Nazim Tulakhodzhayev","Animation, Science Fiction","dYb1upI1O44SlYXChcl2A6qUNeF.jpg",118792],["Those Awful Hats",1909,2.5,1,"D.W. Griffith","Comedy","qOQ3H9Hd1HzgwXT2cavn4VgyRZy.jpg",118943],["Roman Polanski: A Film Memoir",2011,2.5,1,"Laurent Bouzereau","Documentary","xNuOybVO3fFrGenvhJxrpfslF2i.jpg",119415],["Dawn of the Planet of the Apes",2014,3.5,1,"Matt Reeves","Science Fiction, Action, Drama, Thriller","kScdQEwS9jPEdnO23XjGAtaoRcT.jpg",119450],["The Consequences of Feminism",1906,3.5,1,"Alice Guy-Blaché","Comedy","7ZzPyv5g4ohGcPbbmkF2ZYMe02N.jpg",120026],["The Origin of Stitch",2005,2,1,"Mike Disa","Animation, Family, Comedy, Science Fiction","AcJC9aV3FY6nShAYZhHJSImI8hb.jpg",120115],["The Grand Budapest Hotel",2014,5,2,"Wes Anderson","Comedy, Drama","eWdyYQreja6JGCzqHWXpWHDrrPo.jpg",120467],["K-ON! The Movie",2011,3.5,1,"Naoko Yamada","Animation, Family, Adventure, Comedy, Music","aRe9m2K3IGhgruRc9yHUYxQIhI4.jpg",120811],["Marrying God",2007,3,1,"Duke Johnson","Drama","gfsWDsumN27DfIbXe4yd1dqQwRo.jpg",121452],["Stand Up Guys",2012,2,1,"Fisher Stevens","Thriller, Comedy, Action, Crime","pOXmX1rldFQv3rFkWwe4uqbPWPJ.jpg",121824],["Assassin's Creed",2016,1.5,1,"Justin Kurzel","Action, Adventure, Science Fiction","kDXewoEcvbn0pUvJ8W3vfkuWgHw.jpg",121856],["Ginger & Rosa",2012,2.5,1,"Sally Potter","Drama","5EmQri2RwjN5zELdAtUY52k71pN.jpg",121872],["Thursday Till Sunday",2012,3.5,1,"Dominga Sotomayor","Drama","mIYOZeRC0NE1ynuvIaK774ZQwby.jpg",121929],["Frances Ha",2012,4,1,"Noah Baumbach","Comedy, Drama","jrq1NoKvsxWCcffVOjegiYwloFN.jpg",121986],["Macario",1960,3.5,1,"Roberto Gavaldón","Drama, Fantasy","rjNx5OFpLsgwihYZ0A0pchnioo4.jpg",122019],["Spring Breakers",2012,4,1,"Harmony Korine","Drama, Crime","9tyPnyEkL44qbAliM9jMRWc6bjg.jpg",122081],["Three Sad Tigers",1968,3.5,1,"Raúl Ruiz","Comedy, Drama","3QiPIg5SyXdHvIpaZMQOFMhMcPR.jpg",122097],["Baby's Meal",1895,2.5,1,"Louis Lumière","Documentary, Family","ntWwo3J08OduqlGD0niNiAlhZfx.jpg",122134],["The Private Life of a Cat",1946,3,1,"Maya Deren","Documentary","cgR6aNjvwb6urIaxntmqW2RnHi8.jpg",122479],["About Time",2013,3.5,1,"Richard Curtis","Drama, Romance, Fantasy","iR1bVfURbN7r1C46WHFbwCkVve.jpg",122906],["The Hobbit: The Battle of the Five Armies",2014,2,1,"Peter Jackson","Action, Adventure, Fantasy","xT98tLqatZPQApyRmlPL12LtiWp.jpg",122917],["Honeymoon",1998,3.5,1,"Dan Sallitt","Drama, Romance","zIRSEwfC1lSAnQHw9YVqtXBSZDt.jpg",122943],["London 2012 Olympic Opening Ceremony: Isles of Wonder",2012,3.5,1,"Danny Boyle","Documentary","uZGn8dMhGsGLEX8G8CRdRxFT6eK.jpg",123024],["Pieta",2012,4,1,"Kim Ki-duk","Drama","cI9SXHxBsEF0cgUTZKDDaPC0ozT.jpg",123377],["The Act of Killing",2012,5,1,"Joshua Oppenheimer","Documentary, History","sp5B7Tz5ttsgOLnIlCP5uEhtesI.jpg",123678],["To Die By Your Side",2011,2.5,1,"Spike Jonze","Animation, Comedy, Fantasy, Adventure","eJv2Y57dfoOE075uE6irB4PchQJ.jpg",123979],["Godzilla (2014)",2014,3,1,"Gareth Edwards","Action, Drama, Science Fiction","tphkjmQq8WebuVwNXelmjLUXuPJ.jpg",124905],["The Wind in the Willows",1949,3,1,"James Algar","Animation, Family, Comedy","zMRokrWAWccuqgDCNvQoKJEPHlS.jpg",125244],["Soda Stereo: MTV Unplugged Comfort and music to fly",1996,4.5,1,"Milton Lage","Music","4y9eKh2DtHalwhJqdzNd2NkIvJh.jpg",125246],["Gustavo Cerati - Ahi Vamos Tour",2007,3.5,1,"","Music","7VHVNx8skR4Aq2YNxKVtwh8rtsy.jpg",126293],["Ernest & Celestine",2012,4,1,"Benjamin Renner","Animation, Family, Crime, Drama, Comedy","iJPbRASktYW0I009Ktc2zUE6Fvg.jpg",126319],["Sandow",1896,2.5,1,"William K.L. Dickson","Documentary","v9W18L4PYmer4gUl5vNt6G8LTph.jpg",126413],["Sherlock: The Final Problem",2017,2.5,1,"Benjamin Caron","Mystery, TV Movie, Crime, Adventure","zHCBBn2asb00aOOfzsThnuCIzun.jpg",126850],["Alien: Covenant",2017,2.5,1,"Ridley Scott","Horror, Science Fiction","zecMELPbU5YMQpC81Z8ImaaXuf9.jpg",126889],["Cousin Ben Troop Screening",2012,2,1,"Wes Anderson","Comedy","u0SbegbpJGPXkKXDNeTfkhtYOIB.jpg",126909],["Don't Hug Me I'm Scared",2011,4,2,"Becky Sloan & Joseph Pelling","Animation, Comedy, Horror, Music","kXBvc3wkK33ibj9HK7pF9X0Uiwe.jpg",127144],["Finding Dory",2016,3,1,"Andrew Stanton","Adventure, Animation, Family","3UVe8NL1E2ZdUZ9EDlKGJY5UzE.jpg",127380],["Snow-White",1933,4,1,"Dave Fleischer","Animation, Fantasy, Comedy, Music","zc2dE51FEJ5owav8jwVdXlOBrGX.jpg",127409],["Soñar, soñar",1976,4,1,"Leonardo Favio","Drama, Comedy","vc30zARSmbcnmS5BifqPWEMuKF9.jpg",127423],["Nazareno Cruz and the Wolf",1975,4.5,1,"Leonardo Favio","Drama, Fantasy, Horror","nIkf9pzWZECZpfVMTnqrofFi28C.jpg",127424],["X-Men: Days of Future Past",2014,3.5,1,"Bryan Singer","Action, Adventure, Science Fiction","tYfijzolzgoMOtegh1Y7j2Enorg.jpg",127585],["Very Nice, Very Nice",1961,4,1,"Arthur Lipsett","Documentary","nXRhGRgIwjulrVJMPajv1SvuR6Q.jpg",127835],["7 Boxes",2012,3,1,"Tana Schémbori","Action, Thriller","8RjbBaeMaMpdBZIzd6FWYxW7xHv.jpg",127847],["What Richard Did",2012,3,1,"Lenny Abrahamson","Drama","m9Cq5ueENbP16X7cJtOxGYbTUW8.jpg",128248],["Felix in Hollywood",1923,2,1,"Otto Messmer","Animation","3P3ztTCe5jL0Rza8m5ZsUT5NhH7.jpg",128754],["Letter from Siberia",1957,4,1,"Chris Marker","Documentary","4xnIh5yBLgn4xCGAyBF2rv6ZqnQ.jpg",128831],["Hunger (1974)",1974,3,1,"Peter Foldès","Animation","9McTS3W9k5CaAj0CzPXNrOz0oRG.jpg",129067],["Wadjda",2012,3,1,"Haifaa al-Mansour","Drama","w4iCIZ1kWSOCt0yELjfUMNAToUF.jpg",129112],["Boat Leaving the Port",1895,2.5,1,"Louis Lumière","Drama, Documentary","9P6CPyLSXf7juIcHmJ0xP3GhB1O.jpg",129436],["You Think You're the Prettiest, But You Are the Sluttiest",2009,3.5,1,"Che Sandoval","Comedy","5EKsmAuoGRkdy7FML4NXmMBPcQB.jpg",129590],["Nebraska",2013,4.5,1,"Alexander Payne","Drama, Adventure","o1t2Mw18EEBnl8v4Nby3PFjxnM1.jpg",129670],["Demolition of a Wall",1896,3.5,1,"Louis Lumière","Documentary","t0L46CZ6OxsvixfEklHGtF1JOHc.jpg",129865],["One Hundred Children Waiting for a Train",1988,4.5,2,"Ignacio Agüero","Documentary","i4gWxNamkmODDAujxk6LiiY4JI4.jpg",130269],["Partysaurus Rex",2012,2.5,1,"Mark A. Walsh","Family, Animation, Comedy","ilsfmOWSz2ne40aEwN7QGl37r4k.jpg",130925],["A Mouse's Tale",2007,3.5,1,"Benjamin Renner","Animation","qyiApTFXtpqc7XBZ62WEI3BafHi.jpg",131013],["The Hunger Games: Mockingjay – Part 1",2014,2,1,"Francis Lawrence","Science Fiction, Adventure, Thriller","4FAA18ZIja70d1Tu5hr5cj2q1sB.jpg",131631],["The Hunger Games: Mockingjay – Part 2",2015,1.5,1,"Francis Lawrence","Action, Adventure, Science Fiction","lImKHDfExAulp16grYm8zD5eONE.jpg",131634],["The Battle of Chile: Part I",1975,4,1,"Patricio Guzmán","Documentary, History","6rJnhieQrm5HRt5AGgqxxXrnPKB.jpg",132144],["The Battle of Chile: Part II",1976,3.5,1,"Patricio Guzmán","Documentary","566lwvXAEGoRp7QGspqH8ByBTrF.jpg",132148],["The Battle of Chile: Part III",1979,3,1,"Patricio Guzmán","Documentary","vF1bO0MY0mOLUOoGkaTOi01zaKC.jpg",132150],["Mama",2013,2,1,"Andy Muschietti","Horror","eo8BhR8Q5STmWE9sMLsEPagxmy6.jpg",132232],["Before Midnight",2013,4.5,2,"Richard Linklater","Romance, Drama","qbGKJmNUroDz75kh5Oafoall89e.jpg",132344],["Night Journey",1960,2.5,1,"Alexander Hammid","Music, Drama","piFFaUvGMfGZ6UadsiZpNGQmYGA.jpg",132375],["The '?' Motorist",1906,2.5,1,"Walter R. Booth","Science Fiction, Fantasy, Comedy","c6wZfINe0TL7QNNUGYITb5Ku8SF.jpg",132379],["Gus Visser and His Singing Duck",1925,3,1,"Theodore Case","","6pchl65h1rInhjYiGLx7hiXVy4L.jpg",132508],["Public Enemies: The Golden Age of the Gangster Film",2008,3,1,"Constantine Nasr","Documentary, TV Movie","n8YCIlWEDcz9ZMXUWUykjOp4dyT.jpg",132548],["The Vegetarian Cannibal",2012,2,1,"Branko Schmidt","Drama, Thriller","opq3sFgD6yCB31qsLznvGoSMq9C.jpg",132551],["Stefan vs. Kramer",2012,2,1,"Stefan Kramer","Comedy","lAtssrQbtPVT0yjAK93RKf3vxoL.jpg",132706],["Le manoir du diable",1896,2.5,1,"Georges Méliès","Fantasy, Horror","n9uPKpQGlKrVRDe0NqDAhSzPSmB.jpg",133063],["Scenes from a Marriage",1974,5,1,"Ingmar Bergman","Drama, Romance","ArKEdvJesIktFX8OAhcdKAOLl6I.jpg",133919],["Hair-Raising Hare",1946,3.5,1,"Chuck Jones","Animation, Comedy","sB72GBY4WTgOyW0Onzsh06RPaGK.jpg",134103],["Talking Heads",1980,4,1,"Krzysztof Kieślowski","Music, Documentary","acfcMUsyGL7Eod3aptI09uv04Yh.jpg",134499],["The Girls",1968,4.5,1,"Mai Zetterling","Drama, Comedy","scPW0OP6qcZjAfcHvQaxbNsucaQ.jpg",135337],["Jurassic World",2015,2.5,1,"Colin Trevorrow","Adventure, Science Fiction, Thriller, Action","rhr4y79GpxQF9IsfJItRXVaoGs4.jpg",135397],["Liv & Ingmar",2012,3,1,"Dheeraj Akolkar","Documentary","6b7BepYQvWP0kc3nz70NYqBOMdn.jpg",136786],["The Heat",2013,1.5,1,"Paul Feig","Action, Comedy, Crime","yERBa1y5zNUOTRKQPiDCPIc2fuv.jpg",136795],["Need for Speed",2014,1.5,1,"Scott Waugh","Action, Crime, Drama, Thriller","45D153Bk0bNwonV1w5IBBvqssPV.jpg",136797],["Trolls",2016,2,1,"Mike Mitchell","Adventure, Animation, Comedy, Family, Fantasy","9VlK2j0THZWzhQPq0W3Oc0IIdBB.jpg",136799],["How They Get There",1997,3.5,1,"Spike Jonze","Romance, Comedy","",137014],["Last Vegas",2013,2,1,"Jon Turteltaub","Comedy","9Aht200Eu2jYiE9cEQdFfNDtHl6.jpg",137093],["The Lego Movie",2014,4,2,"Phil Lord & Christopher Miller","Animation, Family, Adventure, Comedy, Fantasy","lbctonEnewCYZ4FYoTZhs8cidAl.jpg",137106],["Edge of Tomorrow",2014,3.5,1,"Doug Liman","Action, Science Fiction","nBM9MMa2WCwvMG4IJ3eiGUdbPe6.jpg",137113],["The Broken Circle Breakdown",2012,4,1,"Felix van Groeningen","Drama","qXpMmQaKvTCCN2tvzvkyuOp8AQC.jpg",137182],["Led Zeppelin: Celebration Day",2012,3.5,1,"Dick Carruthers","Music","K7PZu1bnTs1OE5yFS5BIpIqvCP.jpg",137366],["The Dance of Reality",2013,3,1,"Alejandro Jodorowsky","Drama, Fantasy","2qbsG9t943DciYTHITISzXQltqt.jpg",137698],["The Merry Frolics of Satan",1906,2.5,1,"Georges Méliès","Comedy, Fantasy, Horror","9849q4qp8wHWrhxQ3SUSOPmiluh.jpg",137757],["Don Jon",2013,2.5,1,"Joseph Gordon-Levitt","Romance, Comedy, Drama","uh8bwvgGXeUKzdL4oSul9zxyTcd.jpg",138697],["The Bewitched House",1907,2,1,"Segundo de Chomón","Comedy, Fantasy, Animation, Horror","cbqlLso0yVgZnoFIZ63ylSxXkMN.jpg",138730],["Return to Reason",1923,3.5,1,"Man Ray","Drama","8ioFoJSHZKXirDm5DknoaQybNrE.jpg",138752],["The Conjuring",2013,3.5,1,"James Wan","Horror, Thriller","wVYREutTvI2tmxr6ujrHT704wGF.jpg",138843],["Magic Magic",2013,3,1,"Sebastián Silva","Thriller","xgbECqu8xLVzmHT9p3SuB4HtSpL.jpg",139519],["Kung Fu Panda 3",2016,2.5,1,"Jennifer Yuh Nelson","Animation, Action, Adventure, Comedy, Family","oajNi4Su39WAByHI6EONu8G8HYn.jpg",140300],["Paperman",2012,3.5,1,"John Kahrs","Animation, Family, Romance, Comedy, Fantasy","9tvF744hwTm2Bn9hkDjMfEsysKz.jpg",140420],["Star Wars: The Force Awakens",2015,3.5,3,"J.J. Abrams","Adventure, Action, Science Fiction","wqnLdwVXoBjKibFRR5U3y0aDUhs.jpg",140607],["Mamá",2008,2,1,"Andy Muschietti","Drama, Horror","ngwSZehKMkySsMCwvFZ7OgPZHgZ.jpg",140656],["Mater the Greater",2008,2,1,"John Lasseter","Animation, Family, Comedy","tVrU8hUW2xTjAlIiyAvYVOFFQwd.jpg",140967],["Justice League",2017,1,1,"Zack Snyder","Action, Adventure, Science Fiction","eifGNCSDuxJeS1loAXil5bIGgvC.jpg",141052],["The Miracle on 34th Street",1955,2,1,"Robert Stevenson","TV Movie, Family, Drama, Romance","csvpHmWBtpTvsPVvrqLDQJcX8hQ.jpg",141871],["The Dancing Pig",1907,2,1,"","Comedy","1t3EmYUMFCbqbyt6eRwuZfUkz6z.jpg",142026],["Fresh Guacamole",2012,4,1,"PES","Animation","3uBH7edC9cbJqh180iWmAndVsz0.jpg",142563],["The Pleasure of Love in Iran",1976,3,1,"Agnès Varda","Documentary, Romance","tHw33kFGCTrfcglO9bTyKgGxixZ.jpg",143499],["The Electric Hotel",1908,2.5,1,"Segundo de Chomón","Fantasy, Animation","bDFG4dCpIkyBFU3oKuuA8tiSPcR.jpg",143634],["The Fairly OddParents: School's Out! The Musical",2005,3,1,"Butch Hartman","Animation, TV Movie, Comedy, Fantasy, Music, Family","489xqJIazBVqZbITbDCz3aRlYeM.jpg",143874],["Snowball Fight",1897,3,1,"Louis Lumière","Documentary, Comedy","ivopBfMhBn4YQbpBvW99RzwXnUd.jpg",144391],["Electrocuting an Elephant",1903,0.5,1,"Edwin S. Porter","Documentary","qHvPuoI3T0kTNBHUNLF5AUMLbzp.jpg",144464],["Black Panthers",1968,4.5,1,"Agnès Varda","Documentary","vrumxr8mN9TiVDlp3l4S9Ce8UDr.jpg",144597],["Hello Cubans",1963,4,1,"Agnès Varda","Documentary","lsFFLB1dPQVyGRAiaFTPPkynDoE.jpg",144599],["Peel",1983,3.5,1,"Jane Campion","Drama","oqULRb5eMw16JWFYBdgUh9vPj3S.jpg",144678],["I'm So Excited!",2013,2.5,1,"Pedro Almodóvar","Comedy","sQSHPwWlqW9AJEac6sakeIhrMZx.jpg",144789],["Schwechater",1958,3.5,1,"Peter Kubelka","","lFZNrbNn9Sken5t6kIS2fb02N8i.jpg",144886],["A Wild Hare",1940,3.5,1,"Tex Avery","Animation, Comedy","fOVOQ8uMUc5K6WG1WA5cXxVVOxT.jpg",144904],["Upstream Color",2013,4,1,"Shane Carruth","Drama, Science Fiction","zeV2KXaluXjXAq9wBg6Q0LHJjNm.jpg",145197],["Hakuchi: The Innocent",1999,2.5,1,"Makoto Tezuka","Drama, Fantasy, War","otZeJFuxpAKSGslXGnZSDSnKQQW.jpg",145766],["The Double",2013,4,1,"Richard Ayoade","Thriller, Drama","7kNcpmP1Pe9fWLKEbEOX5GEWueC.jpg",146015],["Prisoners",2013,4,1,"Denis Villeneuve","Drama, Thriller, Crime","jsS3a3ep2KyBVmmiwaz3LvK49b1.jpg",146233],["Delivery Man",2013,2,1,"Ken Scott","Comedy","huXHYDclKT4RM1OvS3O7SXYRAU0.jpg",146239],["Liquid Crystals",1978,3,1,"Jean Painlevé","Documentary","epGxvUlsZHz3UlSbz3LxM2AXrzA.jpg",146815],["Hindenburg Disaster Newsreel Footage",1937,3,1,"","Documentary","",146829],["Exodus: Gods and Kings",2014,2,1,"Ridley Scott","Adventure, Drama, Action","uaDj37JtvLan9tihxZ18e6qL33b.jpg",147441],["One Night Stand: Flight of the Conchords",2005,2.5,1,"Linda Mendoza","Comedy, Music","gxpsURgQhtAPrLqKXy8mLGfa1fn.jpg",147502],["Monster Truck Mater",2010,2,1,"John Lasseter","Animation, Comedy, Family, Adventure, Action","ikdzBp4KIDazYgbJJLakZJmfnhn.jpg",148605],["The Wind Rises",2013,3.5,1,"Hayao Miyazaki","Animation, Drama, History, Romance","jfwSexzlIzaOgxP9A8bTA6t8YYb.jpg",149870],["The Tale of The Princess Kaguya",2013,4,1,"Isao Takahata","Animation, Drama, Fantasy","mWRQNlWXYYfd2z4FRm99MsgHgiA.jpg",149871],["Frodo Is Great... Who Is That?!!",2004,2.5,1,"Hannah Clarke","Documentary","o6NbVI1wZ65ZU5yeYauNFzQ8gKS.jpg",149901],["Inside Out",2015,4.5,3,"Pete Docter","Animation, Family, Adventure, Drama, Comedy","2H1TmgdfNtsKlU9jKdeNyYL5y8T.jpg",150540],["Cinderella (2015)",2015,2.5,1,"Kenneth Branagh","Romance, Fantasy, Family, Drama","j91LJmcWo16CArFOoapsz84bwxb.jpg",150689],["Dog's Dialogue",1979,4,1,"Raúl Ruiz","Crime, Drama","hINTLyIZIR8VRrhRk2NvFKilLtW.jpg",150843],["Toss Me a Dime",1958,4,1,"Fernando Birri","Documentary","f1SQDSG2faqhjX4pMjnuxTG80FX.jpg",151441],["I Like Mountain Music",1933,2,1,"Rudolf Ising","Animation, Comedy, Family, Music","pMFqGKPKfYuwGVF4UF1WnV7VEWb.jpg",151913],["Dallas Buyers Club",2013,3.5,1,"Jean-Marc Vallée","Drama, History","7Fdh7gUq3plvQqxRbNYhWvDABXA.jpg",152532],["Blue Is the Warmest Color",2013,4,1,"Abdellatif Kechiche","Romance, Drama","kgUk1wti2cvrptIgUz0VTAtSF6w.jpg",152584],["The Immigrant (2013)",2013,3.5,1,"James Gray","Drama, Romance","ArWRRQYeXL3nG4jYpMOPoBvgmy9.jpg",152599],["Her",2013,5,3,"Spike Jonze","Romance, Science Fiction, Drama","eCOtqtfvn7mxGl6nfmq4b1exJRc.jpg",152601],["Only Lovers Left Alive",2013,3,1,"Jim Jarmusch","Drama, Romance, Fantasy","6xY2MhYjFPb4xU3KlBJcFAJmMsF.jpg",152603],["The Best Offer",2013,2.5,1,"Giuseppe Tornatore","Drama, Romance, Crime","ibDGPgUZn6vxHiSgt2xeQyFp8Np.jpg",152742],["Ain't Them Bodies Saints",2013,3.5,1,"David Lowery","Crime, Drama, Romance, Western","xkGkVjeMcvEg7P3VxWy8wYBJ7Dv.jpg",152748],["The Congress",2013,3.5,1,"Ari Folman","Drama, Science Fiction, Animation","oeT9rwfCBayxgVoUn1yZGmkZlUq.jpg",152795],["Radiohead: The King Of Limbs – Live From The Basement",2011,3.5,1,"Vern Moen","Music, Documentary","8oYIFIqUX6bGPPE17fn8jAXxLQQ.jpg",152940],["Underdogs",2013,1.5,1,"Juan José Campanella","Animation, Adventure, Romance","tJL0oyVmrwSpULCAGaTqs9VMTdM.jpg",153158],["Wisdom Teeth",2010,2.5,1,"Don Hertzfeldt","Comedy, Animation","ytz98kFn7CMozOgl6fnuIAQ4dcK.jpg",153599],["How Did They Ever Make a Movie of Facebook?",2011,3.5,1,"David Prior","Documentary","gu83t0D0UYOGk2p9ufDjT5YllUa.jpg",154352],["Cinderella (1922)",1922,2.5,1,"Walt Disney","Animation","38yrNvZdoI5GLYx4DNnY3NWy9KO.jpg",154450],["Blood of the Condor",1969,3,1,"Jorge Sanjinés","Crime, Drama","7VD8rtdnLQuW17kQ2DePqWjNcyJ.jpg",157319],["Interstellar",2014,5,4,"Christopher Nolan","Adventure, Drama, Science Fiction","gEU2QniE6E77NI6lCU6MxlNBvIx.jpg",157336],["Fruitvale Station",2013,4,1,"Ryan Coogler","Drama","oXSy3nEKFtfw5iRxdG8ouEFAnxs.jpg",157354],["The Spectacular Now",2013,3.5,1,"James Ponsoldt","Comedy, Drama, Romance","tYDbDuZ3K4Xwp3cwtmZM6k53bwq.jpg",157386],["Crystal Fairy & the Magical Cactus",2013,3,1,"Sebastián Silva","Comedy, Adventure, Drama, Romance","jX34ccG13P66S4qVqLRRyR0hZLS.jpg",157409],["Maps to the Stars",2014,3,1,"David Cronenberg","Drama","aoMNfiaMmT7o7wY8oXWCLErZtah.jpg",157851],["Tomorrowland",2015,2.5,1,"Brad Bird","Adventure, Family, Mystery, Science Fiction","kziYpr5Nfw60P0My8aj1sgCEqed.jpg",158852],["Man Walking Around a Corner",1887,2,1,"Louis Aimé Augustin Le Prince","Documentary","iQ7gNpHTyFXKlfX0rvuRWrroLUQ.jpg",159897],["The Boxing Cats",1894,2,1,"William K.L. Dickson & William Heise","Documentary, Comedy, Action","ozdAWQ17qMAdmcS1bWYvBMmrFsG.jpg",159898],["Gloria",2013,4,1,"Sebastián Lelio","Comedy, Drama","t1copJu3ecVx7zVCBA1o6z02WcZ.jpg",160068],["Blue Jasmine",2013,3.5,1,"Woody Allen","Drama","nsj0RLRI10351uYMoAKPur6Derd.jpg",160588],["Hallelujah the Hills",1963,3,1,"Adolfas Mekas","Romance, Comedy","gGKkn6IWfr43MkgVyscV46jXqdV.jpg",161741],["Seasin's Greetinks!",1933,2.5,1,"Dave Fleischer","Animation, Comedy","7a591gfIKh3WceUM3xPQFh11Uux.jpg",161843],["How I Live Now",2013,2,1,"Kevin Macdonald","Drama, Romance, Science Fiction","4drLEdRSIzKZOKLsM79kBvsuq18.jpg",162215],["Procter",2002,3,1,"Joachim Trier","Drama, Mystery","umuypmeZ9PiW38cwoNdYe2gozrH.jpg",162394],["Black Rider",1993,3.5,1,"Pepe Danquart","Comedy","c0F6oLd1Ik1l0pbZC6g03b0Iv29.jpg",162503],["Swimmer",2012,3.5,1,"Lynne Ramsay","Drama","kdwAAlHAzNgIs6Zm8mYVVPdgJQU.jpg",162547],["Serpentine Dance",1897,3,1,"Louis Lumière","Documentary","umI8go82CGenKJGMca4zkm8DvWV.jpg",162767],["Thorvaldsen",1949,3,1,"Carl Theodor Dreyer","Documentary","aXpvgFTA0Ojl2bRNwMIvEpVxJqt.jpg",163107],["H-8...",1958,2.5,1,"Nikola Tanhofer","Drama, Thriller, Crime","aySEEht5iqeFLv0moKMG5aWeRLe.jpg",163774],["The Strange Thing About the Johnsons",2011,3.5,1,"Ari Aster","Drama, Horror","ac2GXs7rJ7eQBKcvjRA3VDSNxA4.jpg",164052],["Kick-Heart",2013,3.5,1,"Masaaki Yuasa","Animation, Comedy, Romance","ewXQsNeSE2BdM274LifeckTDvTQ.jpg",165718],["Fantastic Four (2015)",2015,1,1,"Josh Trank","Action, Adventure, Science Fiction","cDroz5qSlP8xZ6tOpeYoPkBvKyL.jpg",166424],["Pirates of the Caribbean: Dead Men Tell No Tales",2017,1.5,1,"Joachim Rønning","Adventure, Action, Fantasy","6lAPOAFYFWIO3SQRemEY2wInQMC.jpg",166426],["How to Train Your Dragon: The Hidden World",2019,3,1,"Chris Sanders & Dean DeBlois","Animation, Family, Adventure","xvx4Yhf0DVH8G4LzNISpMfFBDy2.jpg",166428],["Brooklyn",2015,3.5,1,"John Crowley","Romance, Drama, History","cs7W8j5lI7qzRW6tKSj9p1Q0Ze7.jpg",167073],["Western Spaghetti",2008,3.5,1,"PES","Animation, Fantasy","iWTVN9WAUkXExF0ewdEZtmcTXmW.jpg",167190],["Furious 7",2015,2.5,1,"James Wan","Action, Crime, Thriller","ktofZ9Htrjiy0P6LEowsDaxd3Ri.jpg",168259],["Chile: Obstinate Memory",1997,3.5,1,"Patricio Guzmán","Documentary","1QTRTFaByM7yMeLehjqBb7tILll.jpg",168421],["American Hustle",2013,3,1,"David O. Russell","Drama, Crime","z6O1KDhfWDTm5ZBr6Ovr0eg8LqO.jpg",168672],["Short Term 12",2013,4,1,"Destin Daniel Cretton","Drama","qKnsyaJZLXfiL2JhIJEkpA8C3LU.jpg",169813],["Inherent Vice",2014,3.5,1,"Paul Thomas Anderson","Drama, Mystery, Comedy","pfVua7TzzttOh3RTOuBqT7xN0oY.jpg",171274],["Frank",2014,4,1,"Lenny Abrahamson","Comedy, Drama, Mystery","mGzqs4CHW8LomreoPATnyrTXk7j.jpg",171372],["Luck, Trust & Ketchup: Robert Altman in Carver Country",1993,3,1,"John Dorr","Documentary","wi7biObfRpjwCn7wmNXGYr8OW6g.jpg",171961],["Life Kills Me",2007,3.5,1,"Sebastián Silva","Comedy, Drama","ywZxFVW6QDrUK3VpUq8A8kK4SKC.jpg",172263],["The Scribbling Kitten",1957,3,1,"Taiji Yabushita","Animation","i2ImPb7XRy0Fnre7bKdL9GXwfwY.jpg",172352],["Rio 2",2014,1.5,1,"Carlos Saldanha","Animation, Adventure, Comedy, Family","gVNTBrjxh2YRmQFjlaqrNbHVvrd.jpg",172385],["Green Vinyl",2004,4,1,"Kleber Mendonça Filho","Drama, Horror, Fantasy","qNbDRkPM61SaMb7QEd0qoU5cj5d.jpg",172513],["The Globalisation Tapes",2003,2.5,1,"Joshua Oppenheimer","Documentary","2kYN7Apao0ByxyFAkrKt6anaN5q.jpg",173666],["Atman",1975,3.5,1,"Toshio Matsumoto","Horror, Animation","74fZ1ajvxtmwMT08cUgG8GkO8a7.jpg",174838],["Bérénice",1983,2.5,1,"Raúl Ruiz","Drama","t4qW919NN3cROsJ17jsvAVIjyxX.jpg",177076],["Big Hero 6",2014,3,1,"Chris Williams","Adventure, Family, Animation, Action, Comedy","2mxS4wUimwlLmI1xp6QW6NSU361.jpg",177572],["Mission: Impossible – Rogue Nation",2015,3.5,1,"Christopher McQuarrie","Action, Adventure","fRJLXQBHK2wyznK5yZbO7vmsuVK.jpg",177677],["Like Father, Like Son",2013,4.5,1,"Hirokazu Kore-eda","Drama","r0nejXOf6e4leWhnLuEQOmC5hrX.jpg",177945],["Leaving Jerusalem by Railway",1897,2.5,1,"Alexandre Promio","Documentary","mfwUZZ0UJolrCVR2UvpVdCpj2h1.jpg",178985],["The Great Beauty",2013,4.5,1,"Paolo Sorrentino","Drama","1cmOc3ZPkuCTOTqHEsRr3Pk81Um.jpg",179144],["Reality+",2014,3.5,1,"Coralie Fargeat","Comedy","l6aty0lfqsTefZ5xduwT7D44N1q.jpg",179150],["Grandma's Reading Glass",1900,2.5,1,"George Albert Smith","Drama","vlLpRPHizzxfvNV7EBoOnWLeASe.jpg",179236],["The Kiss in the Tunnel",1899,2.5,2,"James Bamforth","Romance","oGo9NO8CR2uzIdNQvLMY6DKEXVK.jpg",179537],["The Kiss in the Tunnel (1899)",1899,2.5,2,"George Albert Smith","Romance","oGo9NO8CR2uzIdNQvLMY6DKEXVK.jpg",179537],["T2 Trainspotting",2017,4,1,"Danny Boyle","Drama, Comedy, Crime","xlbpCwa9OXXIiNgXcwuompHFIk9.jpg",180863],["Country Music",2011,3,1,"Alberto Fuguet","Drama","uKZ0ZSZaMTIM70X1s3GSWVIDAFd.jpg",180998],["Star Wars: The Last Jedi",2017,3,1,"Rian Johnson","Adventure, Action, Science Fiction","kOVEVeg59E0wsnXmF9nrh6OmWII.jpg",181808],["Star Wars: The Rise of Skywalker",2019,1.5,1,"J.J. Abrams","Adventure, Action, Science Fiction","db32LaOibwEliAmSL2jjDF6oDdj.jpg",181812],["Enemy",2013,4.5,1,"Denis Villeneuve","Thriller, Mystery","vf40tyDRKZsBmaLsYeopzfFLzLx.jpg",181886],["21-87",1963,3,1,"Arthur Lipsett","Documentary","z9wqODhsxDkN8YpLSrRph8C9UKU.jpg",182099],["Mattress Man Commercial",2003,3,1,"Paul Thomas Anderson","Comedy","iOS9p6NeTwu9dbYTiBL3Mq3prki.jpg",182673],["Lately There Have Been Many Misunderstandings in the Zimmerman Home",2006,2.5,1,"Derek Cianfrance","Comedy","",183665],["Incident by a Bank",2010,4,1,"Ruben Östlund","Action, Comedy, Crime, Drama","mwnVqABU6wkHRjagmPiKoZB1Rt1.jpg",183784],["Las cosas como son",2012,3.5,1,"Fernando Lavanderos","Drama","vnFLkeFUluYXeYihkbh9LaWBB92.jpg",183798],["Young & Beautiful",2013,4,1,"François Ozon","Drama","4RSjzqKIqL5g2OxVIEZQ6ksP1MW.jpg",184314],["Hands of Stone",2016,2.5,1,"Jonathan Jakubowicz","Drama","rpAYkkc7ltnxnMXOZLPuI9A6cuB.jpg",184341],["Tom at the Farm",2013,3,1,"Xavier Dolan","Drama, Thriller, Mystery","df7pp0jSs4wRxfWHtdgCaDPelmm.jpg",184352],["The Hussar of Death",1925,2,1,"Pedro Sienna","History","YWgySzAdaDs9czmD2wRqsSyN8y.jpg",184407],["Film Study",1926,3,1,"Hans Richter","Animation","2OnwbhC4XxmCfp8eDwrY31tDAsn.jpg",184882],["Adventures of a Dentist",1965,2,1,"Elem Klimov","Comedy","5amXAPADjhqKk8M8s4hvNW576Rg.jpg",185057],["Women Reply",1975,3,1,"Agnès Varda","Documentary","wKvmXHLTh2RBb1ck3QY76C2Xlc5.jpg",186365],["22 Jump Street",2014,2.5,1,"Phil Lord & Christopher Miller","Crime, Comedy, Action","850chzYHYbT3IISl6Q7dbBuFP2B.jpg",187017],["Sink & Rise",2004,3,1,"Bong Joon Ho","Comedy","AdWFNGop0s3XvZYHm89qbVz8RX8.jpg",187425],["Age of Bloom",2001,3,1,"Wong Kar-Wai","Drama","7Vijm6LezZvQXqiAritLOang81p.jpg",187548],["Happy and Glorious",2012,2,1,"Danny Boyle","Action, Comedy","lUwbj57j0vZ5b3B7AUwmyOWTXML.jpg",188454],["Star Trek Beyond",2016,2.5,1,"Justin Lin","Action, Adventure, Science Fiction","cnQp8GmOWahIgQaH60Kwez3TNzw.jpg",188927],["The Unchanging Sea",1910,3.5,1,"D.W. Griffith","Drama","hKzeqkgnCvnWwNv0dvc3YqRKk1u.jpg",189584],["My Josephine",2003,2.5,1,"Barry Jenkins","Drama","hHPX3s5s4SF19wnRiCd9WC05iyr.jpg",189923],["The Little Match Seller",1902,2,1,"James Williamson","Drama","w9dIH1YCoscnZCynra7YfDJl4xX.jpg",190651],["The Terrible Eruption of Mount Pelee and Destruction of St. Pierre, Martinique",1902,2.5,1,"Georges Méliès","Drama","fPVGmoRpvvDlGWGKVsG5obW8JX9.jpg",190659],["American Sniper",2014,2.5,1,"Clint Eastwood","War, Action","i1U46OwMc6vlm7OoSUKfqUH615e.jpg",190859],["The Day Dorival Faced the Guard",1986,2.5,1,"Jorge Furtado","Comedy","nMpSXzkgeDtOZ2oCL2L03WLVS7P.jpg",191382],["Jodorowsky's Dune",2013,4,1,"Frank Pavich","Documentary","cVwyAK5clGBQYe7Gu6GsBsUiYh1.jpg",191720],["Alsino and the Condor",1982,2.5,1,"Miguel Littín","Drama, War","1DSrf8RKgyDf5AyuMZAflPYbAc2.jpg",192721],["Birdman or (The Unexpected Virtue of Ignorance)",2014,5,2,"Alejandro G. Iñárritu","Drama, Comedy","rHUg2AuIuLSIYMYFgavVwqt1jtc.jpg",194662],["Play",2005,3,1,"Alicia Scherson","","",195474],["Neighbors",2014,2,1,"Nicholas Stoller","Comedy","sN1RU08CMi8xkRIibremh3AOdgw.jpg",195589],["Le village de Namo - Panorama pris d'une chaise à porteurs",1900,2.5,1,"Gabriel Veyre","Documentary","vRduQJsUlPBuQAgndDz3cmj7wyJ.jpg",195647],["The Good Life",2008,3.5,1,"Andrés Wood","Drama","7iRciud5XPJWqRFjqRSOFNA9aRm.jpg",196324],["Venus in Fur",2013,4,1,"Roman Polanski","Drama","b9pCYixO3ZO7tB303efB3O4nkqC.jpg",197082],["Chappie",2015,2.5,1,"Neill Blomkamp","Crime, Action, Science Fiction","uuDUpzlMFomdSfNWlpEPS9nVZWV.jpg",198184],["Begin Again",2013,3,1,"John Carney","Comedy, Music, Romance, Drama","qx4HXHXt528hS4rwePZbZo20xqZ.jpg",198277],["About Crying",2006,2,1,"Matías Bize","Drama","72G2LStsNXQaw8Fzr7FiTdQ3ATG.jpg",198639],["The Ninth Circle",1960,2.5,1,"France Štiglic","Drama, War, Thriller, Romance","c1POMAizG2WlOtILxvRiCMWgD6U.jpg",198909],["Crimson Peak",2015,3,1,"Guillermo del Toro","Horror, Mystery, Romance, Drama, Thriller","f9TOb5anVwZeSbYjU1qNxPk3KUk.jpg",201085],["Sábado",2003,4,1,"Matías Bize","Drama","gxabjkaOBjnj0F9D9SlXoYQgQVT.jpg",201797],["The Man from U.N.C.L.E.",2015,3.5,1,"Guy Ritchie","Comedy, Action, Adventure","y5yZaForGSJbPD66Cvq9AT5WMAD.jpg",203801],["Tea Time",2014,4.5,1,"Maite Alberdi","Documentary","y5HjYuw09Ffqs9xD2LnudvKNrca.jpg",204506],["The Gardener",1912,2.5,1,"Victor Sjöström","Drama","nx5xenqjyjlbYqg67XIQFYi227U.jpg",205504],["Gods of Egypt",2016,1.5,1,"Alex Proyas","Action, Adventure, Fantasy","hzH7fwaTyQNITLo40Hu3R7cVMqv.jpg",205584],["The Imitation Game",2014,3,1,"Morten Tyldum","History, Drama, Thriller, War","zSqJ1qFq8NXFfi7JeIYMlzyR0dx.jpg",205596],["Spectre",2015,3,1,"Sam Mendes","Action, Adventure, Thriller","zj8ongFhtWNsVlfjOGo8pSr7PQg.jpg",206647],["The Black Balloon",2012,3,1,"Josh Safdie & Benny Safdie","Drama","x7uC2U4AJxWV01C2S5Y0K1oZ8qY.jpg",207307],["Kingsman: The Secret Service",2014,3.5,2,"Matthew Vaughn","Crime, Comedy, Action, Adventure","r6q9wZK5a2K51KFj4LWVID6Ja1r.jpg",207703],["Batman v Superman: Dawn of Justice",2016,2,1,"Zack Snyder","Action, Adventure, Fantasy","5UsK3grJvtQrtzEgqNlDljJW96w.jpg",209112],["Ida",2013,4,1,"Paweł Pawlikowski","Drama","3uoCttE46RGHybiA26cXTvmFqbW.jpg",209274],["Next Door",1990,2.5,1,"Pete Docter","Animation","mN4ANoatsXkl9CawiMrNMCvke5s.jpg",209674],["Palm Springs (1989)",1989,2.5,1,"Pete Docter","Animation","qpi6EelzDw2EyNcbw8nCm70TxrV.jpg",209676],["Somewhere in the Arctic...",1986,2,1,"Andrew Stanton","Animation","6PUOVv8kj417IB9cBGnfWld6gXI.jpg",209681],["The Smile Man",2013,3.5,1,"Anton Lanshakov","Comedy, Drama","2VQ1fH5GovXxc3xC6BY81zE93fq.jpg",210293],["Locke",2013,4,1,"Steven Knight","Drama, Thriller","tTREq5tTyYwmSLDRMhybJ82zXcX.jpg",210479],["Roof Sex",2002,2.5,1,"PES","Animation","bHZlh6IiMKmUFKslhir78z6zOqO.jpg",210548],["Gone Girl",2014,4,1,"David Fincher","Mystery, Thriller, Drama","ts996lKsxvjkO2yiYG0ht4qAicO.jpg",210577],["Minions",2015,2,1,"Kyle Balda","Family, Animation, Adventure, Comedy","dr02BdCNAUPVU07aOodwPYv6HCf.jpg",211672],["Chef",2014,3,1,"Jon Favreau","Comedy","hyp8EXDmO4dSC8V6Q5jU7gD1kcg.jpg",212778],["Animated Self-Portraits",1989,3.5,1,"MANY","Animation","8AONS1rNQr1oIfJPTltc8Y8majp.jpg",213080],["Toy Story of Terror!",2013,2.5,1,"Angus MacLane","Adventure, Animation, Comedy, Family","oPBEnNP4Fg4gv9c0KBhchmtoG4H.jpg",213121],["La Morte Rouge",2006,4,1,"Víctor Erice","Documentary","ngT91LmBJbJbdr2UtQz8B3JZLSN.jpg",213598],["Ted 2",2015,2,1,"Seth MacFarlane","Comedy, Fantasy","38C91I7Xft0gyY7BITm8i4yvuRb.jpg",214756],["Moebius",2013,1.5,1,"Kim Ki-duk","Drama","wREeBv5vVAHQkLiHF2PVQIPkBVo.jpg",215743],["Fifty Shades of Grey",2015,1,1,"Sam Taylor-Johnson","Drama, Romance, Thriller","63kGofUkt1Mx0SIL4XI4Z5AoSgt.jpg",216015],["Coherence",2013,3,1,"James Ward Byrkit","Thriller, Science Fiction","ezUtb9m5DeLwL2gxi4gktzNCvQv.jpg",220289],["Sub terra",2003,2.5,1,"Marcelo Ferrari","Drama, Romance","huU8ssHZ0csFiEtRuk4Ky7vdmE6.jpg",220672],["Venice 70: Future Reloaded",2013,3,1,"MANY","Drama, Documentary","pHRlMgNdMUA5jJpEYqcYzR6WYZK.jpg",220709],["Two Days, One Night",2014,4.5,1,"Jean-Pierre Dardenne & Luc Dardenne","Drama","2qpZZ5a5Axpk8OeCtrvNTQfJiB2.jpg",221902],["They Saved Hitler's Brain",1968,0.5,1,"David Bradley","Science Fiction, Thriller, Adventure, TV Movie","rpZeXWUxvrUuHE7Wtjyl4VOvhHF.jpg",222258],["Aloha",2015,1.5,1,"Cameron Crowe","Drama, Comedy, Romance","58Y4CjcRX8AtMNtI0AXu9H7iebP.jpg",222936],["Slow West",2015,3.5,1,"John Maclean","Western, Drama, Adventure, Romance, Thriller","j3PmbRZvf5KpNbapSjn8b0CpD6a.jpg",223485],["Sausage Party",2016,2.5,1,"Conrad Vernon","Adventure, Animation, Comedy, Fantasy","vNgdPJQ5CI60oEiiHLKRNrsDhMy.jpg",223702],["Daffy's Diner",1967,2,1,"Robert McKimson","Animation, Comedy","aTztK3wtS2eYSUPkJuv4fSieyML.jpg",224056],["Into the Woods",2014,2,1,"Rob Marshall","Fantasy, Comedy","bINGDDuvUnZyde2sIcSx41IE5b6.jpg",224141],["Two Ships",2012,3,1,"Justine Triet","Drama","nAJ4FSG5PuN92peIcUpvinEFidF.jpg",224613],["Non-Stop",2014,2,1,"Jaume Collet-Serra","Action, Thriller, Mystery","Nkgaj3X0W2jHQ1TzHEgWFpN3kJ.jpg",225574],["Macbeth",2015,3,1,"Justin Kurzel","Drama, War","a5NEpil29Uns1wEYF8k99qVgj1T.jpg",225728],["Much Better Than You",2013,2.5,1,"Che Sandoval","Comedy","6TMDKGHWo7fXVezsEa6VunknOfz.jpg",225930],["Horrible Bosses 2",2014,1.5,1,"Sean Anders","Comedy","boBOkwIqgrs8noxBUSDkkicKa4K.jpg",227159],["The Peanuts Movie",2015,3,1,"Steve Martino","Animation, Comedy, Family","aiwdwnl7RFs1vcBanOKr13ye3wE.jpg",227973],["Fury (2014)",2014,2.5,1,"David Ayer","War, Drama, Action","pfte7wdMobMF4CVHuOxyu6oqeeA.jpg",228150],["The SpongeBob Movie: Sponge Out of Water",2015,2,1,"Mike Mitchell","Adventure, Animation, Comedy, Family, Fantasy","2WDmjUlSAPlA27i2OwEC7sRTFw3.jpg",228165],["The Book of Life",2014,1.5,1,"Jorge R. Gutierrez","Animation, Family, Fantasy","aotTZos5KswgCryEzx2rlOjFsm1.jpg",228326],["The Interview",2014,2,1,"Evan Goldberg & Seth Rogen","Action, Comedy","tIDC4xT65l7a8qbgg8GvwD5g8c5.jpg",228967],["Magic in the Moonlight",2014,3,1,"Woody Allen","Comedy, Drama, Romance","mNYZUVDj4ORSPHWinmqJbXyuG6W.jpg",229297],["Mur Murs",1981,4,1,"Agnès Varda","Documentary","dFU0gAIUeSS0k96it0LhCNN8v9R.jpg",230048],["The Story of Petroleum",1923,2.5,1,"","Documentary","aTP5F2qfJQSwrGeO1bse0oW4JOR.jpg",231555],["Bring Me the Head of the Machine Gun Woman",2012,3,1,"Ernesto Díaz Espinoza","Action, Crime","hRLfAug1FgrhNIP90ZZXq8gUp7K.jpg",232195],["Pride",2014,3,1,"Matthew Warchus","Drama, Comedy","Kc3vbqO0X4VRnjACGNoWLNQvHo.jpg",234200],["Castello Cavalcanti",2013,3.5,1,"Wes Anderson","Comedy, Drama","iGZHMSIxbsvjG1M5PfUYq1doMDK.jpg",236028],["Any Bonds Today?",1942,1.5,1,"Robert Clampett","History, Animation, Comedy","2c6ro1wdhiYVgV12LwGO0xtZaiW.jpg",236582],["Spanish Affair",2014,3,1,"Emilio Martínez Lázaro","Comedy, Romance","vUbn2Dy9qWWV8VnktvuGn9YiCRL.jpg",236737],["A Long Journey",1967,3,1,"Patricio Kaulen","Drama","u9c8SqnbJmny5o27Ueli7CF1kKJ.jpg",236835],["Apocrypha",2009,2.5,1,"Andrey Zvyagintsev","Drama","iZDD11VEu5cMIhvjptTYOLjedFO.jpg",237143],["Pacific 231",1949,3.5,1,"Jean Mitry","Music","1jRcnH35bC4hK7AMBlsOyTGPZOU.jpg",237187],["The Way He Looks",2014,3.5,1,"Daniel Ribeiro","Drama, Romance","4Vu2r8hS3bDqGmmghxYfNCtyX4o.jpg",237791],["Caluga o Menta",1990,2.5,1,"Gonzalo Justiniano","Crime, Drama","n7YtI2UgiWFIJU7ftw11Csapd26.jpg",238262],["Little White Dove",1992,4.5,1,"Raúl Ruiz","Drama, Romance, Comedy","dWwwtXoKFRq9Bky6fnbo2MIfNRH.jpg",238268],["Coronation",2000,3.5,1,"Silvio Caiozzi","Drama","zoFvSw10Y0DoTfKKpaZgRZN7xog.jpg",238272],["Spy",2015,3,1,"Paul Feig","Action, Comedy, Crime","vPBmfMHxQvRRNGYD5S5ko2KnX56.jpg",238713],["Along the Coast",1958,3,1,"Agnès Varda","Documentary","5bETPcUHBEPsSuNxquiisAs2uUv.jpg",238952],["120 Seconds to Get Elected",2006,2,1,"Denis Villeneuve","Comedy","geRTiYuNVbrIsNDk3SJT1tTAg0p.jpg",239070],["Kite Adrift",2013,3.5,1,"Diego Ayala","Thriller, Drama","6s3kljVGgkC0jI3YaMCt6iSHC0x.jpg",239109],["Lucy",2014,1.5,1,"Luc Besson","Action, Science Fiction","kRbpUTRNm6QbLQFPFWUcNC4czEm.jpg",240832],["A Most Violent Year",2014,3.5,1,"J.C. Chandor","Crime, Drama, Thriller","gYTUNxLcFomCdXe3D4Hq8OLwgv0.jpg",241239],["Alice Through the Looking Glass",2016,1.5,1,"James Bobin","Adventure, Family, Fantasy","kbGamUkYfgKIYIrU8kW5oc0NatZ.jpg",241259],["The Guest",2014,3.5,1,"Adam Wingard","Mystery, Thriller, Action","8hGMD8PhOJrzkew0RZyOWqDhGJR.jpg",241848],["As the Gods Will",2014,3.5,1,"Takashi Miike","Thriller, Horror, Comedy","3Obn9IR47fjhbtYtNrO7CBSrZ2w.jpg",241863],["The Babadook",2014,3.5,1,"Jennifer Kent","Drama, Horror","qt3fqapeo94TfvMyld8P7gkpXLz.jpg",242224],["Nightcrawler",2014,4,1,"Dan Gilroy","Crime, Drama, Thriller","j9HrX8f7GbZQm1BrBiR40uFQZSb.jpg",242582],["When Marnie Was There",2014,3.5,1,"Hiromasa Yonebayashi","Animation, Drama, Family","vug1dvDI1tSa60Z8qjCuUE7ntkO.jpg",242828],["Bo Burnham: What.",2013,3.5,2,"Bo Burnham","Comedy, Music","kGDpMWPOKStmvf4F1gkqfeFZmXA.jpg",244001],["I Origins",2014,3,1,"Mike Cahill","Science Fiction, Drama","2P31jhd1dWUAPD8dmnSrwkQ8CNN.jpg",244267],["The Voices",2014,4,1,"Marjane Satrapi","Comedy, Crime, Horror, Fantasy","weY5OVSFmxvA3D4lfyhgvugklEh.jpg",244458],["Whiplash",2014,4.5,2,"Damien Chazelle","Drama, Music, Thriller","7fn624j5lj3xTme2SgiLCeuedmO.jpg",244786],["Suffragette",2015,2.5,1,"Sarah Gavron","Drama, History","y706qec117bN2S7XgCs2Yz8jEfv.jpg",245168],["Midnight Special",2016,3,1,"Jeff Nichols","Adventure, Drama, Science Fiction","hgDRq1l4ATxwufWjILKsYtglbI6.jpg",245703],["John Wick",2014,3.5,1,"Chad Stahelski","Action, Thriller","fZPSd91yGE9fCcCe6OoQr6E3Bev.jpg",245891],["She's Funny That Way",2014,2,1,"Peter Bogdanovich","Comedy, Romance","2FiZVfwz27bvMROkud3dlFyE8uA.jpg",245906],["X-Men: Apocalypse",2016,2,1,"Bryan Singer","Science Fiction, Fantasy, Action","2mtQwJKVKQrZgTz49Dizb25eOQQ.jpg",246655],["What We Do in the Shadows",2014,4.5,3,"Taika Waititi","Comedy, Horror","a2rD3i3DBMeYbA34rBv6z3B9S3a.jpg",246741],["Clouds of Sils Maria",2014,3.5,1,"Olivier Assayas","Drama","dtCZ31RlokpkAaKMr9jFCJjBngi.jpg",246860],["The American Way",1962,3,1,"Marvin Starkman","Comedy","f1NKYzmvXcN9th5kfYv2mLtZ83Y.jpg",247838],["Hitman: Agent 47",2015,1,1,"Aleksander Bach","Action, Crime, Thriller","cx9AOBOv9Qf5ufZYQMbfTV7w7VY.jpg",249070],["Nymphomaniac: Vol. II",2013,3,1,"Lars von Trier","Drama, Mystery","iLUNqgNKuWn667kXCKztSxYbT3k.jpg",249397],["The Diary of a Teenage Girl",2015,3,1,"Marielle Heller","Drama, Romance, Comedy","5YlUrdYKuscD7pwf3yy9duVLbui.jpg",250124],["To Kill a Man",2014,4,1,"Alejandro Fernández Almendras","Thriller, Drama","pbXsjomsAYm15bQkBO6apKwMjNq.jpg",250374],["Far from the Madding Crowd (2015)",2015,3,1,"Thomas Vinterberg","Drama, Romance","cr4cctBPv9qHDtjDps4wi0kqI7h.jpg",250734],["Her: Love in the Modern Age",2014,3,1,"Lance Bangs","Documentary","yq4j7uBuNXKUlti2726PEnqu2Wb.jpg",250853],["Kung Fury",2015,2.5,1,"David Sandberg","Action, Comedy, Science Fiction, Fantasy","f1QpIlCqlFXp1hjnLplXb5irxip.jpg",251516],["A Girl Walks Home Alone at Night",2014,3.5,1,"Ana Lily Amirpour","Horror, Romance","cd2rCE1nun7CESjBI8PGNEof1tb.jpg",252171],["While We're Young",2014,3.5,1,"Noah Baumbach","Comedy, Drama","rdYXGeK3OZjBrd2R8A1sSS0Kxcq.jpg",252512],["Pixies: Live at Brixton Academy 1991",1991,3,1,"Toru Uehara","Music, Documentary","ueD7ZvhW4zRCylPchw3rERRMYlc.jpg",253035],["High-Rise",2015,3,1,"Ben Wheatley","Drama","47aaJXO87scDABLUT7vg2bHsdrF.jpg",254302],["The Lobster",2015,4.5,1,"Yorgos Lanthimos","Comedy, Drama, Romance","7Y9ILV1unpW9mLpGcqyGQU72LUy.jpg",254320],["Pitch Perfect 2",2015,1.5,1,"Elizabeth Banks","Comedy, Music","oFBQUufCV4c8WZoNhtGM17p884H.jpg",254470],["Don't Hug Me I'm Scared 2",2014,3.5,2,"Becky Sloan & Joseph Pelling","Horror, Animation, Fantasy, Music, Comedy","crjgxvIq6lGP7oL0kq1gXQJAOXE.jpg",255384],["Balnearios",2002,3,1,"Mariano Llinás","Documentary","d7vaY3AoyM2UoewquS0cryq7E86.jpg",255979],["Bāhubali: The Beginning",2015,2,1,"S. S. Rajamouli","Action, Drama","9BAjt8nSSms62uOVYn1t3C3dVto.jpg",256040],["Under Construction (Or The Place Where I Was Born No Longer Exists)",2000,3.5,1,"Ignacio Agüero","Documentary","c6AXBrMtuNxdkNlkZXuO4AVHWVF.jpg",256310],["Danny Collins",2015,2.5,1,"Dan Fogelman","Music, Comedy, Drama","sf9ndc9l6alP9DhJF1ZpKz1PaXK.jpg",256924],["The Intern",2015,2.5,1,"Nancy Meyers","Comedy","bTQ46fupPbjBfFBHuzfD3hxxL0Q.jpg",257211],["Tamako Love Story",2014,3,1,"Naoko Yamada","Romance, Animation, Comedy","5P57bEbKzmp6MyK5r3IDqH5f8aJ.jpg",257475],["Nymphomaniac: Vol. I",2013,3.5,1,"Lars von Trier","Drama","piikL8vRh3s1ysHGTIqaZpdjfNU.jpg",258216],["A Monster Calls",2016,3,1,"J. A. Bayona","Fantasy, Adventure, Family","vNzWJwVqjszWwXrA7ZfsrJmhgV9.jpg",258230],["Carol",2015,4.5,3,"Todd Haynes","Romance, Drama","cJeled7EyPdur6TnCA5GYg0UVna.jpg",258480],["The Legend of Tarzan",2016,2,1,"David Yates","Fantasy, Action, Adventure","eJrfz178xBGlxjDGxnBXTzWWa4w.jpg",258489],["Dialogues of the Exiles",1975,3.5,1,"Raúl Ruiz","Drama","c3G0CopqRsntbzq5aimrU7XsV6u.jpg",258563],["Fantastic Beasts and Where to Find Them",2016,2.5,1,"David Yates","Fantasy, Adventure","fLsaFKExQt05yqjoAvKsmOMYvJR.jpg",259316],["The Conjuring 2",2016,3,1,"James Wan","Horror","zEqyD0SBt6HL7W9JQoWwtd5Do1T.jpg",259693],["Live by Night",2016,2,1,"Ben Affleck","Action, Crime, Drama, Thriller","bkd46T4RplawnDjpHoI8mhzTLks.jpg",259695],["Lights Out (2013)",2013,3,1,"David F. Sandberg","Horror","1VzEIaYWO9HFIp6lgjfbLRJRKSF.jpg",259761],["Deadpan",1997,2.5,1,"Steve McQueen","","",259862],["Taken 3",2014,1,1,"Olivier Megaton","Thriller, Action","vzvMXMypMq7ieDofKThsxjHj9hn.jpg",260346],["Incredibles 2",2018,3,1,"Brad Bird","Action, Adventure, Animation, Family","9lFKBtaVIhP7E2Pk0IY1CwTKTMZ.jpg",260513],["Cars 3",2017,2.5,1,"Brian Fee","Animation, Drama, Family","zg5RDxvIIAKsucjuU2EZJIHEIvz.jpg",260514],["Kate Bush Christmas Special",1979,4,1,"Roy Norton","Music","83gtWxslJzizGVJRQ69Tf1uk7ge.jpg",260695],["And... We've Got Sabor",1967,3,1,"Sara Gómez","Documentary, Music","kRn9mRvcs6bcZYSSfTrM0wbdezj.jpg",262027],["I'm Going to Santiago",1964,3,1,"Sara Gómez","Documentary","tPnKAZGCN2RYop4VwWSmQu40EfR.jpg",262028],["Ani*Kuri15: Good Morning",2007,4,2,"Satoshi Kon","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Ani*Kuri15: A Gathering of Cats",2007,3.5,1,"Makoto Shinkai","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Ani*Kuri15: Attack of Higashimachi 2nd Borough",2007,1.5,1,"","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Ani*Kuri15: Blaze Man",2007,1.5,1,"","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Ani*Kuri15: From the Other Side of the Tears",2007,2.5,1,"","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Ani*Kuri15: Gyrosopter",2007,2,1,"","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Ani*Kuri15: Invasion from Space - Hiroshi's Case",2007,2,1,"","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Ani*Kuri15: Project Mermaid",2007,2,1,"","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Ani*Kuri15: Project Omega",2007,2,1,"","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Ani*Kuri15: Princess Onmitsu",2007,3,1,"Mahiro Maeda","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Ani*Kuri15: Sancha (The Aromatic Tea) Blues",2007,3,1,"","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Ani*Kuri15: Wandaba Kiss",2007,2.5,1,"","Adventure, Animation, Comedy, Drama, Family, Fantasy","9YrTQAKVJaDUgDOVevZ0LJbhJGm.jpg",262833],["Boy Meets Girl",2014,2.5,1,"Eric Schaeffer","Comedy, Drama, Romance","sxgQDPNkky07l1bv9g8AyoB4jJp.jpg",263105],["Shaun the Sheep Movie",2015,4.5,3,"Richard Starzak","Family, Animation, Comedy, Adventure","1GMvKNy2Ht5QwI0oV0ycYnxzWdC.jpg",263109],["Logan",2017,4,1,"James Mangold","Action, Drama, Science Fiction","fnbjcRDYn6YviCcePDnGdyAkYsB.jpg",263115],["Knock Knock",2015,1,1,"Eli Roth","Horror, Thriller, Crime","cUC4rUb1Cs2KMaZ6RD4uYUEEwls.jpg",263472],["Coffee and Cigarettes II",1989,3,1,"Jim Jarmusch","Comedy","yHBVwbMkeHLZoeBH13vcoSm11D0.jpg",263912],["You've Got Beautiful Stairs, You Know...",1986,3,1,"Agnès Varda","Documentary","nXBPYqQP8K7MHGBVORZnRSfmXB7.jpg",264290],["Room",2015,4.5,2,"Lenny Abrahamson","Drama, Thriller","2hHDMeYyZjbGWn0BeNH1cTMxuM7.jpg",264644],["Ex Machina",2015,4.5,1,"Alex Garland","Drama, Science Fiction","dmJW8IAKHKxFNiUnoDR7JfsK7Rp.jpg",264660],["Mommy",2014,5,2,"Xavier Dolan","Drama","uPDP0cHGOpkr47rdCdHWo4CyiPj.jpg",265177],["Force Majeure",2014,4,1,"Ruben Östlund","Drama","41agNfzepz2DTdgTBX1fX0QclHp.jpg",265189],["Wild Tales",2014,4.5,2,"Damián Szifron","Drama, Thriller, Comedy","bU7IUeTdYFOgeUPtwpWKQNhORMC.jpg",265195],["The Salt of the Earth",2014,4,1,"Wim Wenders","Documentary","jRmQNj8NacAHJnzwfvFvglKSGB6.jpg",265297],["Weird: The Al Yankovic Story (2010)",2010,3,1,"Eric Appel","Comedy","bOsN34gcKTN5l5QVJj4kkh5sjks.jpg",265647],["A Girl at My Door",2014,3.5,1,"July Jung","Drama","clsf4ahm1KYucXxTZBEOZ3YJUyp.jpg",266058],["Girlhood",2014,3,1,"Céline Sciamma","Drama","qZ52DlSVguX0WHYoiOD464IIONd.jpg",266082],["The Theory of Everything",2014,2.5,1,"James Marsh","Drama, Romance","7kwcLFNt887saoQAL7EY0XnW7VI.jpg",266856],["The Look of Silence",2014,4,1,"Joshua Oppenheimer","History, Documentary","7TakQLT8gyzIMG8hX8RLTd5qROQ.jpg",267480],["Our Father",2005,3,1,"Rodrigo Sepúlveda","Comedy, Drama","jIDgcg8jOyuMrkh9GevZ9qNZDgH.jpg",268342],["Naomi Campbel",2013,2,1,"Camila José Donoso","Drama","oQyB34Q81RcMqqEIRWoKJINj8Ne.jpg",268366],["Pockets",2012,3.5,1,"Daniel Kwan & Daniel Scheinert","Fantasy, Comedy","ose4CArOzfbLfhe3npgO9t4Qxta.jpg",268840],["Zootopia",2016,3.5,1,"Byron Howard","Animation, Adventure, Family, Comedy","hlK0e0wAQ3VLuJcsfIYPvb4JVud.jpg",269149],["The Club",2015,4.5,1,"Pablo Larraín","Drama","r334FPNCgmYbiFDrZCmWGeWNMBZ.jpg",270302],["It Follows",2014,3.5,1,"David Robert Mitchell","Horror, Mystery","iwnQ1JH1wdWrGYkgWySptJ5284A.jpg",270303],["Hail, Caesar!",2016,2.5,1,"Joel Coen & Ethan Coen","Comedy, Mystery","ozY79UvbYvJUWFg2UCM1CDQ7rBl.jpg",270487],["Captain America: Civil War",2016,3,1,"Anthony Russo & Joe Russo","Adventure, Action, Science Fiction","rAGiXaUfPzY7CDEyNKUofk3Kw2e.jpg",271110],["The Tribe",2014,1.5,1,"Myroslav Slaboshpytskyi","Drama, Crime","85gHJfR9aM3mRIHq6G5ateLGOeh.jpg",271397],["Love & Mercy",2014,3.5,1,"Bill Pohlad","Drama, Music, History","4jn0hDsl6lsv4qEc7aiLlgbaIjo.jpg",271714],["Trainwreck",2015,2.5,1,"Judd Apatow","Comedy, Romance","wrY629UTCUAKLJ4CxQXz6DCE7pr.jpg",271718],["Over the Garden Wall",2014,4.5,1,"Nate Cash","Music, Comedy, Romance","pr1snPkxmWjLkVI1ryxeVhAe61b.jpg",273191],["The Hateful Eight",2015,3,1,"Quentin Tarantino","Drama, Mystery, Western","jIywvdPjia2t3eKYbjVTcwBQlG8.jpg",273248],["Sicario",2015,4,2,"Denis Villeneuve","Action, Crime, Thriller","lz8vNyXeidqqOdJW9ZjnDAMb5Vr.jpg",273481],["Selma",2014,3,1,"Ava DuVernay","History, Drama","wq4lhMc4BuOyQqe1ZGzhxLyy3Uk.jpg",273895],["Losing Ground",1982,2,1,"Kathleen Collins","Comedy, Drama","zSZT7ndjNUsskQq9IWosW3a9cbk.jpg",273896],["B-Happy",2003,3.5,1,"Gonzalo Justiniano","Drama","unzckX72mjQug32eoukVFR9kJIY.jpg",274104],["Priorities",2014,2.5,1,"Gints Zilbalodis","Animation, Adventure","rDxkpkbbMGw7yqP9aPPdard874A.jpg",274353],["Joy",2015,2,1,"David O. Russell","Drama","nZAs0HbW82TI1i4Xid83M941Pki.jpg",274479],["King Arthur: Legend of the Sword",2017,2,1,"Guy Ritchie","Action, Drama, Fantasy","9kKXH6eJpzoFGhCbTN3FVwSQK3n.jpg",274857],["Passengers",2016,2.5,1,"Morten Tyldum","Drama, Romance, Science Fiction","jK9S6HANSf2no64v1x1HxfcpmcA.jpg",274870],["Remembering the Artist: Robert De Niro, Sr.",2014,3,1,"Perri Peltz","Documentary","c4MbPv8fnGvHXTvAvIvCx6eyYtT.jpg",275315],["Ricki and the Flash",2015,2.5,1,"Jonathan Demme","Comedy, Drama, Music","y9hw9XSk8uVgLRfq3cweiAEJtU.jpg",275601],["Uncle Yanco",1967,4.5,2,"Agnès Varda","Documentary","ffZpsbJGuRoMKBQ1ZZ14v06NK7Y.jpg",277677],["Moana",2016,3.5,1,"John Musker & Ron Clements","Adventure, Comedy, Family, Animation","9tzN8sPbyod2dsa0lwuvrwBDWra.jpg",277834],["The Memory of Water",2015,3,1,"Matías Bize","Drama, Romance","3N3Kqo661eHmZAZvBCNnffuGesY.jpg",278464],["The Jungle Book (2016)",2016,3.5,1,"Jon Favreau","Adventure, Family, Fantasy","2Epx7F9X7DrFptn4seqn4mzBVks.jpg",278927],["The Lego Movie 2: The Second Part",2019,2.5,1,"Mike Mitchell","Action, Adventure, Animation, Comedy, Family","QTESAsBVZwjtGJNDP7utiGV37z.jpg",280217],["War for the Planet of the Apes",2017,3,1,"Matt Reeves","Drama, Science Fiction, War","mMA1qhBFgZX8O36qPPTC016kQl1.jpg",281338],["The Revenant",2015,4,2,"Alejandro G. Iñárritu","Western, Drama, Adventure","ji3ecJphATlVgWNY0B0RVXZizdf.jpg",281957],["Irrational Man",2015,3,1,"Woody Allen","Drama, Comedy","ipAqhEWRzEuD6aXlAWIvEEF1KUe.jpg",282984],["Kahlil Gibran's The Prophet",2014,2.5,1,"MANY","Animation","rkg2thsR4r4H02FVVW1M1FyqhpL.jpg",283161],["99 Homes",2014,3.5,1,"Ramin Bahrani","Drama, Crime","6Zul5Spndok1WriSMfiyQFbAyLY.jpg",283235],["Miss Peregrine's Home for Peculiar Children",2016,2,1,"Tim Burton","Adventure, Fantasy","CIlbMFOfYDj0MP23hsIYhFGrL6.jpg",283366],["The Light Between Oceans",2016,3.5,1,"Derek Cianfrance","Drama, Romance","c9S6VKZPllNgdxBUuI3GYJiqcKO.jpg",283552],["Evangelion: 3.0+1.0 Thrice Upon a Time",2021,4.5,2,"Hideaki Anno","Animation, Action, Science Fiction, Drama","md5wZRRj8biHrGtyitgBZo7674t.jpg",283566],["Beasts of No Nation",2015,3.5,1,"Cary Joji Fukunaga","Drama, War","1D4vcJmJc58WXarpRtwgd2do9Rg.jpg",283587],["Foureyes",2013,3,1,"Conor Byrne","Comedy","5kH9O6NQGCwlKPtEQrhg9phXLQn.jpg",283822],["Guardians of the Galaxy Vol. 2",2017,4.5,3,"James Gunn","Science Fiction, Adventure, Action","y4MBh0EjBlMuOzv9axM4qJlmhzz.jpg",283995],["Mr. Kaplan",2014,3.5,1,"Álvaro Brechner","Drama, Comedy","h0ACKbI6bYZDpKBiBVdSA2XvtFK.jpg",284050],["Doctor Strange",2016,3,1,"Scott Derrickson","Fantasy, Adventure, Action","xf8PbyQcR5ucXErmZNzdKR0s8ya.jpg",284052],["Thor: Ragnarok",2017,4,1,"Taika Waititi","Action, Science Fiction, Comedy, Adventure","rzRwTcFvttcN1ZpX2xv4j3tSdJu.jpg",284053],["Black Panther",2018,3.5,2,"Ryan Coogler","Action, Adventure, Science Fiction","uxzzxijgPIY7slzFvMotPv8wjKA.jpg",284054],["Still Alice",2014,3,1,"Wash Westmoreland","Drama","yY6ypZPQl67J4RwOA6YBALNS3Wj.jpg",284293],["Incredible Floridas",1972,3,1,"Peter Weir","Documentary, Music","q1LShEBDOSnezCmnlvjdiP21xWw.jpg",284475],["Heaven Knows What",2014,3,1,"Josh Safdie & Benny Safdie","Drama, Crime","4oyWMOWJ6trsRuyzn5cHPv50zVH.jpg",285024],["The Walk",2015,3,1,"Robert Zemeckis","History, Drama, Adventure","lSoPmBq0kaU9jwZNbpEVwua8J3s.jpg",285783],["Grindhouse",2007,3.5,1,"Quentin Tarantino","Thriller, Action, Horror","tvMBwJlmQTIQf5EBjHzzyE9tjcN.jpg",285923],["Lava",2014,2.5,1,"James Ford Murphy","Animation, Family","9HI4rM3ewc26yTUfCV0IT0k3wJs.jpg",286192],["The Martian",2015,3.5,1,"Ridley Scott","Science Fiction, Drama, Adventure","3ndAx3weG6KDkJIRMCi5vXX6Dyb.jpg",286217],["Shazam!",2019,3,1,"David F. Sandberg","Action, Comedy, Fantasy","xnopI5Xtky18MPhK40cZAGAOVeV.jpg",287947],["The Handmaiden",2016,5,1,"Park Chan-wook","Thriller, Drama, Romance","dLlH4aNHdnmf62umnInL8xPlPzw.jpg",290098],["The Nice Guys",2016,4,2,"Shane Black","Comedy, Crime, Action","clq4So9spa9cXk3MZy2iMdqkxP2.jpg",290250],["Roger Waters: The Wall",2014,4,1,"Roger Waters","Music","oFPVC3ival04a9Yijm716QXOsCA.jpg",290382],["Terminator: Dark Fate",2019,2,1,"Tim Miller","Science Fiction, Action, Adventure, Thriller","vqzNJRH4YyquRiWxCCOH0aXggHI.jpg",290859],["Anomalisa",2015,4,1,"Charlie Kaufman","Animation, Drama, Romance, Comedy","4DJ1zNr4Y6q7zQ27goEYla46VdO.jpg",291270],["Now You See Me 2",2016,1,1,"Jon M. Chu","Crime, Thriller","A81kDB6a1K86YLlcOtZB27jriJh.jpg",291805],["Dirty Grandpa",2016,1,1,"Dan Mazer","Comedy","k0Lz1TfSlbcQthQKYGwE7blDfwN.jpg",291870],["The Death & Life of John F. Donovan",2018,2.5,1,"Xavier Dolan","Drama","2bhI7Ivk7VmvUaJaDTxJUgOXp1E.jpg",291984],["Richard Jewell",2019,3.5,1,"Clint Eastwood","Drama, History, Crime","5Lgkm8jt4roAFPZQ52fKMhVmDaZ.jpg",292011],["Love",2015,2.5,1,"Gaspar Noé","Drama, Romance","yz6lmOmsmYuj6AOLG4LIwK5eJZF.jpg",292431],["Kong: Skull Island",2017,3,1,"Jordan Vogt-Roberts","Action, Adventure, Fantasy","r2517Vz9EhDhj88qwbDVj8DCRZN.jpg",293167],["Feast",2014,3,1,"Patrick Osborne","Animation, Comedy, Drama, Family","6hAgSxgd2YIK5pYhwowtnlGpwbe.jpg",293299],["Deadpool",2016,4,2,"Tim Miller","Action, Adventure, Comedy","3E53WEZJqP6aM84D8CckXx4pIHw.jpg",293660],["The Wailing",2016,3.5,1,"Na Hong-jin","Horror, Mystery","aXlL7yYwpXInhltamtzKQFBG08G.jpg",293670],["The Age of Adaline",2015,2,1,"Lee Toland Krieger","Romance, Fantasy, Drama","MbILysGhjAbnZi1Okae9wYqLMx.jpg",293863],["Trumbo",2015,3,1,"Jay Roach","Drama","2RERIRnZkROSeHZAIf8PSxhzOqs.jpg",294016],["Pete's Dragon",2016,2.5,1,"David Lowery","Adventure, Family, Fantasy","A9x4Ogk8KUXTfU649NS6lS9TCmu.jpg",294272],["Everybody Wants Some!!",2016,3,1,"Richard Linklater","Comedy","vAIFZ8bw0spSvcIYgfuX99B3H2w.jpg",295699],["Phantom",1975,3,1,"Toshio Matsumoto","","nKXBg0FX7IlZ0wYWhiMxZOMsAEe.jpg",295791],["Bridge of Spies",2015,3.5,1,"Steven Spielberg","Thriller, Drama","fmOOjHAQzxr0c1sfcY4qkiSRBH6.jpg",296098],["Naples Is a Battlefield",1944,3,1,"Jack Clayton","Documentary","xRGOikJYIYPgbOZoFTeWbHyiVtZ.jpg",296105],["Love & Friendship",2016,3,1,"Whit Stillman","Drama, Romance, Comedy","ptpdUQiRjeHgE1dmpCd38N64ENV.jpg",296360],["Deepwater Horizon",2016,2.5,1,"Peter Berg","Drama, Action","jgBIYCZACe3iaS9TL2XzVGkO5p5.jpg",296524],["The Man Who Killed Don Quixote",2018,3.5,1,"Terry Gilliam","Adventure, Comedy","4o4zw2c9sfHvszIb5xpuFagnouR.jpg",297725],["Notes on a True Story",1951,2.5,1,"Luchino Visconti","Documentary","tKEkw2AaL9Y0ZhkxUOxpvrYojbY.jpg",297757],["Suicide Squad",2016,1,1,"David Ayer","Action, Adventure, Fantasy","sk3FZgh3sRrmr8vyhaitNobMcfh.jpg",297761],["Wonder Woman",2017,3,1,"Patty Jenkins","Action, Adventure, Fantasy","v4ncgZjG2Zu8ZW5al1vIZTsSjqX.jpg",297762],["Aquaman",2018,2,1,"James Wan","Action, Adventure, Fantasy","ufl63EFcc5XpByEV2Ecdw6WJZAI.jpg",297802],["Night of the Living Doo",2001,2,1,"Casper Kelly","Family, Animation, Comedy, Adventure, Mystery, TV Movie, Horror","aivTxgtMuUFbLPuGshi4OY4Nzla.jpg",298015],["Jigsaw",2017,2,1,"Michael Spierig","Horror, Mystery","7RwHxhdUNS996JPFNB9a7CJtlwR.jpg",298250],["The Visit",2015,2,1,"M. Night Shyamalan","Horror, Thriller","mtMfKRCa2V5b7d9k4piogB72mcY.jpg",298312],["The Flash",2023,1.5,1,"Andy Muschietti","Action, Science Fiction, Adventure","rktDFPbfHfUbArZ6OOOKsXcv0Bm.jpg",298618],["Avengers: Endgame",2019,3.5,1,"Anthony Russo & Joe Russo","Adventure, Science Fiction, Action","bR8ISy1O9XQxqiy0fQFw2BX72RQ.jpg",299534],["Avengers: Infinity War",2018,4,2,"Anthony Russo & Joe Russo","Adventure, Action, Science Fiction","7WsyChQLEftFiDOVTGkv3hFpyyt.jpg",299536],["Captain Marvel",2019,2.5,1,"Ryan Fleck & Anna Boden","Action, Adventure, Science Fiction","AtsgWhDnHTq68L0lLsUrCnM7TjG.jpg",299537],["The Other Side of the Wind",2018,3.5,1,"Orson Welles","Drama","pFeWBVcCehkdr1BvXaVrepGUJQK.jpg",299782],["3 Generations",2015,2.5,1,"Gaby Dellal","Comedy, Drama","g4kR79ndKP6gZFHXe70sY7TUOZ7.jpg",300667],["Annihilation",2018,3.5,1,"Alex Garland","Science Fiction, Horror","4YRplSk6BhH6PRuE9gfyw9byUJ6.jpg",300668],["Don't Breathe",2016,3.5,1,"Fede Álvarez","Horror, Thriller, Crime","dSxHyPZ2nipSfvdft4IhQKjk5eZ.jpg",300669],["Don't Hug Me I'm Scared 3",2014,3.5,2,"Becky Sloan & Joseph Pelling","Horror, Fantasy, Animation, Music","mXWDueBDVr7PBsrvEeDOlzRmYpG.jpg",300790],["Downsizing",2017,2,1,"Alexander Payne","Drama, Science Fiction, Comedy","5bNzInSSAXfr0MFlHfb4IoQePVx.jpg",301337],["The Neon Demon",2016,3.5,1,"Nicolas Winding Refn","Horror","3rBo2AfWSlvsPmYFdJsNUMfkNIo.jpg",301365],["Blonde",2022,2.5,1,"Andrew Dominik","Drama","mEeHqtnWOR44vLCutEFku2WK6ou.jpg",301502],["Toy Story 4",2019,3.5,1,"Josh Cooley","Family, Comedy, Animation, Adventure","w9kR8qbmQ01HwnvK4alvnQ2ca0L.jpg",301528],["Too Many Cooks",2014,4.5,3,"Casper Kelly","Crime, Horror, Science Fiction, Comedy","mloofB4SaWLJCh1eGHb0dPvVybE.jpg",301566],["Made in Milan",1990,3.5,1,"Martin Scorsese","Documentary","44Xm8r819NnodzmFK5c2H7o6rRe.jpg",301814],["Interesting Ball",2014,3.5,1,"Daniel Kwan & Daniel Scheinert","Fantasy, Comedy","t28m0w4QoTPem8b9SxYkbD84b95.jpg",301937],["Snowden",2016,3,1,"Oliver Stone","Drama, History, Crime, Thriller","yfK7zxNL63VWfluFuoUaJj5PdNw.jpg",302401],["The Accountant",2016,2,1,"Gavin O'Connor","Crime, Thriller, Drama","fceheXB5fC4WrLVuWJ6OZv9FXYr.jpg",302946],["Nobody Said Anything",1971,2,1,"Raúl Ruiz","Comedy","vQJsiYZ1bTYwZsKjTQiRpZu69Tp.jpg",303474],["Dragon Ball Z: Resurrection 'F'",2015,2,1,"Tadayoshi Yamamuro","Action, Animation, Science Fiction","soq3AxjALdBfdPAm8H7yuMmNL5Y.jpg",303857],["World of Tomorrow",2015,4.5,1,"Don Hertzfeldt","Animation, Drama, Science Fiction","5s7DSOek7Bk2CvcG1zX01bJzJ0x.jpg",303867],["A Kitten Named Woof",1976,3.5,1,"Lev Atamanov","Animation","83FaaqxUbPxrQ1knTv4Y8RUelx6.jpg",306027],["A Kitten Named Woof: The Second Story",1977,3,1,"Lev Atamanov","Animation","qOE1lT79eJrpJZoK8qdbQWaW7Yv.jpg",306032],["The Danish Girl",2015,3.5,2,"Tom Hooper","Drama","mXZZIacI5FC8thzSC0lgQBQ2uAX.jpg",306819],["Magallanes",2015,3.5,1,"Salvador del Solar","Drama","bVzC42W7RLWJIOXxRJPgYDTovKF.jpg",306838],["The Invitation",2015,2.5,1,"Karyn Kusama","Thriller, Horror","otZMaGHWnKPgOODF6SSVNGqbI4X.jpg",306947],["Southpaw",2015,3,1,"Antoine Fuqua","Action, Drama","kSQ49Fi3NVTqGGXILmxV2T2pdkG.jpg",307081],["Love on a Leash",2011,0.5,1,"Fen Tian","Drama, Comedy, Romance, Fantasy","lKMaQ0kbaPGjJA5OzZP13z8sbw9.jpg",307124],["Junior (2011)",2011,3,1,"Julia Ducournau","Horror, Fantasy, Drama","4tRF43CbEYHmV8VywkbikQwATB8.jpg",307130],["Coda (2013)",2013,3,1,"Alan Holly","Drama, Animation","g4sTN0q7ndnjccIhdpGHZ7q2p8c.jpg",307696],["Tangerine",2015,4,1,"Sean Baker","Comedy, Drama","EKLR5c61XQzBTeMokFrmS3kdt8.jpg",308084],["War Dogs",2016,2.5,1,"Todd Phillips","Comedy, Crime, Drama","mDcPRjZC1bb6LavFU3gwsWdVfCM.jpg",308266],["Me and Earl and the Dying Girl",2015,3.5,1,"Alfonso Gomez-Rejon","Drama, Comedy","eLjS2bLMjln2n2I73Xu6TaANPDZ.jpg",308369],["Mistress America",2015,3,1,"Noah Baumbach","Comedy","1Y9rlzMIfzwjKI6eaCEV9J2eqfH.jpg",309245],["Fuerzas Especiales",2014,1,1,"José Miguel Zúñiga","Action, Comedy","rBngIuVAgP0MOzSLlBvf6OWOrkZ.jpg",309268],["The Little Prince",2015,2.5,1,"Mark Osborne","Adventure, Animation, Fantasy, Family","je5Z7gbFTzrs3FPHINo9yGiHoVo.jpg",309809],["Submarine Sandwich",2014,3,1,"PES","Animation","6OZBahd6f0oBzpoYVHriv5uXkad.jpg",309911],["The Witch",2015,4.5,2,"Robert Eggers","Horror","zap5hpFCWSvdWSuPGAQyjUv2wAC.jpg",310131],["The Second Mother",2015,4.5,1,"Anna Muylaert","Drama","u1tDQun2iJAzersd94S8P47WEOL.jpg",310569],["Youth",2015,4,1,"Paolo Sorrentino","Comedy, Drama, Romance","ceRN51oeadmccAvqvDxpnnNRcLU.jpg",310593],["The Great Wall",2016,1.5,1,"Zhang Yimou","Action, Adventure, Fantasy","p70dq1YxabemdZDm5K6Q8G10wSn.jpg",311324],["Creed",2015,3.5,1,"Ryan Coogler","Drama","1BfTsk5VWuw8FCocAhCyqnRbEzq.jpg",312221],["Kubo and the Two Strings",2016,4,1,"Travis Knight","Animation, Adventure, Family","la6QA9tk4Foq8OBH2Dyh5dTcw6H.jpg",313297],["La La Land",2016,5,7,"Damien Chazelle","Comedy, Drama, Romance","uDO8zWDhfWwoFdKS4fzkUJt0Rf0.jpg",313369],["Green Room",2015,3.5,1,"Jeremy Saulnier","Horror, Crime, Thriller","evZicaR7nXe4LiD9G6QYTorcJGO.jpg",313922],["The Lost City of Z",2016,3,1,"James Gray","Adventure, Drama, History","8SxHVNk6tqXYwygmDzz1YuJEm2J.jpg",314095],["Spotlight",2015,4,2,"Tom McCarthy","History, Drama","8DPGG400FgaFWaqcv11n8mRd2NG.jpg",314365],["By the Sea",2015,2,1,"Angelina Jolie","Drama, Romance","oEyeG4UyAQvYIJiFpUV57Q3PTDp.jpg",314385],["Dheepan",2015,3,1,"Jacques Audiard","Crime, Drama","qNMjRNrIzvljInNLf3aLYZI3Ih4.jpg",314402],["Mar",2014,2,1,"Dominga Sotomayor","Drama","5wxEjrGvqt3XXWQXJvPVtWoiO0y.jpg",314573],["Shin Godzilla",2016,4.5,1,"Hideaki Anno","Action, Science Fiction, Horror","jPNShaWZMpVF0iQ7j1dvTuZLD20.jpg",315011],["Puss in Boots: The Last Wish",2022,4,1,"Joel Crawford","Animation, Adventure, Fantasy, Comedy, Family","kuf6dutpsT0vSVehic3EZIqkOBt.jpg",315162],["The Boy and the Beast",2015,3,1,"Mamoru Hosoda","Action, Adventure, Animation, Drama, Family, Fantasy","kzKJxfIdZ70nsPfKyq7hlYlJwSx.jpg",315465],["Spider-Man: Homecoming",2017,3,2,"Jon Watts","Action, Adventure, Science Fiction","c24sv2weTHPsmDa7jEMN0m2P3RT.jpg",315635],["Florence Foster Jenkins",2016,2.5,1,"Stephen Frears","Comedy, Drama","1HAdtUchzWEo0LMFHrgD2UBIBS3.jpg",315664],["Ghost in the Shell (2017)",2017,2,1,"Rupert Sanders","Science Fiction, Drama, Action","9gC88zYUBARRSThcG93MvW14sqx.jpg",315837],["Our Little Sister",2015,4,1,"Hirokazu Kore-eda","Drama","x9A0AtEg5EEYbDGfP8NqH3C9w8M.jpg",315846],["Passage of Venus",1874,2.5,1,"P.J.C. Janssen","Documentary","XWPDZzK7N2WQcejI8W96IxZEeP.jpg",315946],["Mike and Dave Need Wedding Dates",2016,1.5,1,"Jake Szymanski","Comedy","alWBdyvXf1LSixnn1IfID5HMtLx.jpg",316023],["The Greatest Showman",2017,2.5,1,"Michael Gracey","Drama","b9CeobiihCx1uG1tpw8hXmpi7nm.jpg",316029],["The Bad Batch",2016,2.5,1,"Ana Lily Amirpour","Action, Horror, Science Fiction, Thriller, Romance","7o14VaMphEIzPwzeW6FP3A6zb4W.jpg",316154],["Who Killed Captain Alex?",2010,3,1,"Nabwana IGG","Action, Comedy, Drama","2GYBwJJMOrWsEmJRvRl48mQDyTI.jpg",316776],["What Happened, Miss Simone?",2015,3.5,1,"Liz Garbus","Music, Documentary","8XpM91NVq6IyCnDkiWf4xjHpewK.jpg",318044],["The Big Short",2015,3,2,"Adam McKay","Comedy, Drama","scVEaJEwP8zUix8vgmMoJJ9Nq0w.jpg",318846],["Listen to Me Marlon",2015,4.5,1,"Stevan Riley","Documentary","yhqIuN7VC5ZpBDyRnwyVRNR6CC3.jpg",319076],["Morricone Conducts Morricone",2006,3,1,"Giovanni Morricone","Music","j5yP1cIaSr8jZS1vHbVoHu79qfv.jpg",319878],["The Pearl Button",2015,4,1,"Patricio Guzmán","Documentary","g0Vwz4s8Uhm2M9QhA95oh307Mke.jpg",319994],["Diary of a Chambermaid (2015)",2015,2,1,"Benoît Jacquot","Drama","imQp5gncyqgwWygmD4lWDmBrBIw.jpg",320003],["Taxi",2015,4,1,"Jafar Panahi","Comedy, Drama","lY2RW6pxRYyPmrgUF0rjqbeAnTu.jpg",320006],["Victoria",2015,4,1,"Sebastian Schipper","Crime, Thriller, Romance","9P8QgfoMcFX7vp2Gj2cYFecHVRZ.jpg",320007],["Dark Phoenix",2019,1,1,"Simon Kinberg","Science Fiction, Action, Adventure","cCTJPelKGLhALq3r51A9uMonxKj.jpg",320288],["Beauty and the Beast (2017)",2017,2.5,1,"Bill Condon","Family, Fantasy, Romance","hKegSKIDep2ewJWPUQD7u0KqFIp.jpg",321612],["Don't",2007,4,1,"Edgar Wright","","usKthWeFtoFq6prDsbTlyRLWA59.jpg",321646],["Steve Jobs",2015,3.5,1,"Danny Boyle","Drama, History","ljiRO29Y9khEERRqMluptUYunJ9.jpg",321697],["Concussion",2015,2.5,1,"Peter Landesman","Drama","uuRFr7Jhsq7bITDyyvxZrQMAr9e.jpg",321741],["Nine Lives",2016,0.5,1,"Barry Sonnenfeld","Fantasy, Comedy, Family","i457G22lL9t2yhEFdYz5Nd1M5DV.jpg",322240],["Krisha",2015,4,1,"Trey Edward Shults","Drama","xN4xhl5HYhfO9W8Y1ZZEnqmQEip.jpg",323929],["John Wick: Chapter 2",2017,3.5,1,"Chad Stahelski","Action, Thriller, Crime","hXWBc0ioZP3cN4zCu6SN3YHXZVO.jpg",324552],["Jason Bourne",2016,2.5,1,"Paul Greengrass","Action, Adventure, Thriller","xA7N41glw17MBQtcWSm2eBlBRuG.jpg",324668],["Hacksaw Ridge",2016,3,1,"Mel Gibson","Drama, History, War","wuz8TjCIWR2EVVMuEfBnQ1vuGS3.jpg",324786],["A Bigger Splash",2015,3,1,"Luca Guadagnino","Drama, Thriller, Romance","b9ca2L41R43Lg1hpSzJHwtDTvYU.jpg",324807],["The Lego Batman Movie",2017,3.5,2,"Chris McKay","Animation, Action, Comedy, Family","snGwr2gag4Fcgx2OGmH9otl6ofW.jpg",324849],["Despicable Me 3",2017,1.5,1,"Pierre Coffin & Chris Renaud","Action, Animation, Comedy, Family, Adventure","6t3YWl7hrr88lCEFlGVqW5yV99R.jpg",324852],["Spider-Man: Into the Spider-Verse",2018,4.5,2,"Peter Ramsey","Animation, Action, Adventure, Science Fiction","iiZZdoQBEYBv6id8su7ImL0oCbD.jpg",324857],["Neighbors 2: Sorority Rising",2016,2,1,"Nicholas Stoller","Comedy","eyjcLLwxuRXACbglIbwWwaXK9DN.jpg",325133],["Hardcore Henry",2015,2.5,1,"Ilya Naishuller","Action, Adventure, Science Fiction","ik1uZyiMSxF9HqrgRKUNfMCfr3z.jpg",325348],["Rated R for Nudity",2011,2,1,"Denis Villeneuve","Comedy, Animation","9NS92IBW7gJsmCQQXdgZkoWcO4l.jpg",325372],["Endless Poetry",2016,3.5,1,"Alejandro Jodorowsky","Fantasy, Drama","iJTWnSa3YOnD15zMME3ox9GP8XA.jpg",325385],["Wiener-Dog",2016,3.5,1,"Todd Solondz","Comedy, Drama","jL5j9K51S2EraokuheEJki7NUxw.jpg",326094],["Zama",2017,2.5,1,"Lucrecia Martel","Drama, History","kpp9R6iYKSIXxfyW0feVYrk0jsg.jpg",326382],["The Secret Life of Pets",2016,2.5,1,"Pierre Coffin & Chris Renaud","Animation, Comedy, Family, Adventure","g3Hms6AE174doeGR1gz5zX5sVsv.jpg",328111],["Nerve",2016,2.5,1,"Ariel Schulman","Mystery, Adventure, Crime","qmSpHC0CSNyNll9WhlwWYuwoQ28.jpg",328387],["Arrival",2016,5,4,"Denis Villeneuve","Drama, Science Fiction, Mystery","6WzElgkLjIWuWn3Nwu66s5J26tx.jpg",329865],["Dumbo (2019)",2019,2,1,"Tim Burton","Family, Fantasy, Adventure","A7XkpLfNH0El2yyDLc4b0KLAKvE.jpg",329996],["Frozen II",2019,1.5,1,"Chris Buck","Family, Animation, Adventure, Comedy, Fantasy","mINJaa34MtknCYl5AjtNJzWj8cD.jpg",330457],["Rogue One: A Star Wars Story",2016,3.5,1,"Gareth Edwards","Action, Adventure, Science Fiction","i0yw1mFbB7sNGHCs7EXZPzFkdA1.jpg",330459],["The Brand New Testament",2015,3,1,"Jaco Van Dormael","Comedy, Fantasy","eRKgcuXSP9KiGlh2tlS85oh6ceN.jpg",330764],["Days in the Country",2004,2,1,"Raúl Ruiz","Drama","9UZDGoqZeLANwZArAadHGeW99WD.jpg",330857],["Song to Song",2017,3.5,1,"Terrence Malick","Romance, Drama","itmaNi14GyWguTOywZ0mMzyScW9.jpg",330947],["Little Women",2019,4.5,1,"Greta Gerwig","Drama, Romance","yn5ihODtZ7ofn8pDYfxCmxh8AXI.jpg",331482],["Amy",2015,4,1,"Asif Kapadia","Documentary, Music","qL0RepWSNUuZoeDXfyhqowVYhrn.jpg",331781],["Mary Shelley",2017,1.5,1,"Haifaa al-Mansour","Romance, Drama","gKHJTsrfxJtfFNPQJn2hDNEMtFf.jpg",332283],["The Tell-Tale Heart (1971)",1971,3.5,1,"Steve Carver","Horror","ibbWUfMrtE72zWBEhddyBRjB1Ny.jpg",332290],["A Star Is Born (2018)",2018,3,1,"Bradley Cooper","Music, Drama, Romance","wrFpXMNBRj2PBiN4Z5kix51XaIZ.jpg",332562],["The Shallows",2016,2,1,"Jaume Collet-Serra","Horror, Drama, Thriller","bnBV7hZmLuA0Si5Aop481sPF2RY.jpg",332567],["Allende in His Maze",2014,2,1,"Miguel Littín","Drama, History","7lUcrMqfoWuXSFDirVeRh5QNvio.jpg",332813],["Julieta",2016,4,1,"Pedro Almodóvar","Drama, Romance","z4aErD1RQQ3alpu3PoUu408HEVc.jpg",332872],["Ready Player One",2018,2,1,"Steven Spielberg","Adventure, Action, Science Fiction","pU1ULUq8D3iRxl1fdX2lZIzdHuI.jpg",333339],["10 Cloverfield Lane",2016,3.5,1,"Dan Trachtenberg","Thriller, Science Fiction, Drama, Horror","q8A39vcBDruhvoDTJd6L8a4lnTi.jpg",333371],["The Magnificent Seven (2016)",2016,2.5,1,"Antoine Fuqua","Adventure, Action, Western","ezcS78TIjgr85pVdaPDd2rSPVNs.jpg",333484],["Bad Things That Could Happen",2010,3,1,"Becky Sloan & Joseph Pelling","Comedy","qBtH6s9HeHd3vb9OJJ7pHTaEZMI.jpg",333772],["Don't Hug Me I'm Scared 4",2015,3.5,2,"Becky Sloan & Joseph Pelling","Horror, Fantasy, Animation, Music, Comedy","ijM51fcGVIo6uTyqon00ZLQIT0T.jpg",333824],["Basically",2014,3.5,1,"Ari Aster","Comedy, Drama","i0SxIuExIAydkP22QwsA9HMNCQn.jpg",334381],["Free Fire",2016,3.5,1,"Ben Wheatley","Action, Crime, Mystery","olpgs0OPE8sdBGcuuWhKYzxAwN4.jpg",334521],["Captain Fantastic",2016,4,1,"Matt Ross","Drama, Comedy","2sFME73GaD8UsUxPUKe60cPdLif.jpg",334533],["Manchester by the Sea",2016,4.5,2,"Kenneth Lonergan","Drama","o9VXYOuaJxCEKOxbA86xqtwmqYn.jpg",334541],["My Big Night",2015,2,1,"Álex de la Iglesia","Comedy, Music, Drama","tcXv39wbVtx9uU756M6yg5GrPgV.jpg",335053],["The Chinese Shoe",1979,2.5,1,"Cristián Sánchez","Drama","5HgjzKloMnKEyuFV6p1kvt12GA.jpg",335494],["Natural Disasters",2014,3.5,1,"Bernardo Quesney","Comedy, Drama","dsmdkqmr4foqpwsxaVLT1zTKxaz.jpg",335591],["Uncharted",2022,2,1,"Ruben Fleischer","Action, Adventure, Mystery","rJHC1RUORuUhtfNb4Npclx0xnOf.jpg",335787],["Sing",2016,1.5,1,"Garth Jennings","Animation, Comedy, Family, Music","rwopfpHqPCYBSgBuZwkaXXqHp14.jpg",335797],["Indiana Jones and the Dial of Destiny",2023,2,1,"James Mangold","Adventure, Action","Af4bXE63pVsb2FtbW8uYIyPBadD.jpg",335977],["Venom",2018,2,1,"Ruben Fleischer","Science Fiction, Action","2uNW4WbgBXL25BAbXGLnLqX71Sw.jpg",335983],["Blade Runner 2049",2017,5,3,"Denis Villeneuve","Science Fiction, Drama","gajva2L0rPYkEWjzgFlBXCAVBE5.jpg",335984],["Son of Saul",2015,3.5,1,"László Nemes","War, Drama, Thriller","9ZcX6NjCJam5uwkooXffhHI29Lj.jpg",336050],["The High Sun",2015,3,1,"Dalibor Matanić","Drama, Romance, War","16ya0jVWtxojF57aL2KJciZxKKB.jpg",336206],["Rams",2015,3,1,"Grímur Hákonarson","Drama","pk75njhxcxTJAl0FJ1V2ROGIEy1.jpg",336222],["Mustang",2015,3.5,1,"Deniz Gamze Ergüven","Drama","8lrsjdydRxhKlKiGuMbbzuFKrdN.jpg",336804],["Embrace of the Serpent",2015,4,1,"Ciro Guerra","Drama, Adventure","t3Lmw8jvm7tpik0lSkub8hU4oRW.jpg",336808],["The OceanMaker",2014,3,1,"Lucas Martell","Drama, Action, Animation, Science Fiction","jg8QZwWMXk9jZu7qac84BVHDuQd.jpg",336893],["Karadima Forest",2015,3,1,"Matias Lira","Drama","xjmipY93H5HRk4BS79cDSYpGTRu.jpg",337101],["The Fate of the Furious",2017,2,1,"F. Gary Gray","Action, Crime, Thriller","dImWM7GJqryWJO9LHa3XQ8DD5NH.jpg",337339],["Mulan (2020)",2020,1.5,1,"Niki Caro","Adventure, Fantasy, Action","jAbexAtB0aSfP5Ay4TpWHARyVnG.jpg",337401],["Cruella",2021,2.5,1,"Craig Gillespie","Comedy, Crime, Drama","hjS9mH8KvRiGHgjk6VUZH7OT0Ng.jpg",337404],["Elle",2016,4,1,"Paul Verhoeven","Drama, Thriller","z446adpGUVXXPxrLpKBGnYBcofk.jpg",337674],["The Chilean Charles Bronson (Or Exactly Identical)",1981,2.5,1,"Carlos Flores Delpino","Documentary","",337762],["It's Only the End of the World",2016,2.5,1,"Xavier Dolan","Drama","riWa3WZrO3n8lLWuaEVMgaqAZGn.jpg",338189],["The Beauty Inside",2015,3.5,1,"Baik","Fantasy, Romance","z5gpjqQwo0h8rMvBLedRXfHHDKb.jpg",338729],["Bloodshot",2020,1.5,1,"David S. F. Wilson","Action, Science Fiction, Adventure","8WUVHemHFH2ZIP6NWkwlHWsyrEL.jpg",338762],["Hell or High Water",2016,4,1,"David Mackenzie","Western, Crime, Drama","ljRRxqy2aXIkIBXLmOVifcOR021.jpg",338766],["Fantastic Beasts: The Crimes of Grindelwald",2018,1.5,1,"David Yates","Fantasy, Adventure","fMMrl8fD9gRCFJvsx0SuFwkEOop.jpg",338952],["Disenchanted",2022,1.5,1,"Adam Shankman","Comedy, Family, Fantasy","uyNLq2Dc3s4IOdcYTU8ZtM2lTjb.jpg",338958],["Zombieland: Double Tap",2019,2,1,"Ruben Fleischer","Horror, Comedy","dtRbVsUb5O12WWO54SRpiMtHKC0.jpg",338967],["The Entire History of the Louisiana Purchase",1998,3,1,"Joshua Oppenheimer","History, Documentary, Comedy","5EGGY96Qq7t0r2WVhq3ISUPI9XQ.jpg",339139],["Café Society",2016,2.5,1,"Woody Allen","Comedy, Drama, Romance","q9fohCRpQ7m8OTyi82fxa3B86te.jpg",339397],["Baby Driver",2017,5,5,"Edgar Wright","Action, Crime","tYzFuYXmT8LOYASlFCkaPiAFAl0.jpg",339403],["Loving",2016,3,1,"Jeff Nichols","Drama, Romance","teNPeDIRGWxtvMaJsNa7lw5IgiL.jpg",339419],["Loving Vincent",2017,3,1,"Hugh Welchman","Animation, Drama, History","56sq57kDm7XgyXBYrgJLumo0Jac.jpg",339877],["Valerian and the City of a Thousand Planets",2017,2.5,1,"Luc Besson","Adventure, Science Fiction, Action","vlc95gl3PtrjxSEuM8RhTtSm2xU.jpg",339964],["Colossal",2016,4,1,"Nacho Vigalondo","Drama, Fantasy, Science Fiction","4VOyofBd1pexblxtDZYtYIk7NI4.jpg",339967],["The New Mutants",2020,2,1,"Josh Boone","Science Fiction, Horror","xiDGcXJTvu1lazFRYip6g1eLt9c.jpg",340102],["Tag",2015,3,1,"Sion Sono","Horror, Action, Science Fiction, Drama, Fantasy","1xqQv9PoOIVX4nHlKVQELaAHyvG.jpg",340176],["Chi-Raq",2015,3,1,"Spike Lee","Drama, Crime, Comedy","goT9g4Lem6mwkwmehR3mOGJXLBQ.jpg",340275],["American Honey",2016,4,1,"Andrea Arnold","Drama","41SVO0AElBAl7zks9dFhJ0OjHni.jpg",340485],["Certain Women",2016,4,1,"Kelly Reichardt","Drama","jIfW4p27B30zSfGCohB2S4cTRz4.jpg",340487],["Salt and Fire",2016,2,1,"Werner Herzog","Drama, Thriller","3UkmGmAIJPLpBH2TXzNDO8kykkw.jpg",340488],["The Wife",2017,3,1,"Björn Runge","Drama","d4Qyuy0Ul549f6SOdUqGvIdYKD2.jpg",340613],["Nocturnal Animals",2016,4,1,"Tom Ford","Drama, Thriller","mdLDgQBD0va09npSQX5Zgo2evXM.jpg",340666],["Dark Crimes",2016,1,1,"Alexandros Avranas","Drama, Thriller","bEwK1r4pmJ9huEjqrZf73NXJvFy.jpg",340674],["Personal Shopper",2016,4,1,"Olivier Assayas","Drama, Mystery, Thriller","cdm6qZgmbaIwjKBZnUSGWS4eyM2.jpg",340676],["Popstar: Never Stop Never Stopping",2016,3,1,"Akiva Schaffer","Comedy, Music","jBZeZZNjYBUU21zFvBnin5n62bv.jpg",341012],["Atomic Blonde",2017,2.5,1,"David Leitch","Action, Thriller","kV9R5h0Yct1kR8Hf8sJ1nX0Vz4x.jpg",341013],["Puppets",2011,3.5,1,"Daniel Kwan & Daniel Scheinert","Fantasy, Comedy","",341598],["My Best Friend's Wedding/My Best Friend's Sweating",2011,2.5,1,"Daniel Kwan & Daniel Scheinert","Fantasy, Comedy","",341600],["Swingers",2009,2,1,"Daniel Kwan & Daniel Scheinert","Science Fiction, Comedy, Fantasy","mPTWXCvzdxF1SgBjbH5j04ZAYkr.jpg",341604],["Dogboarding",2011,2.5,1,"Daniel Kwan & Daniel Scheinert","Comedy, Fantasy, Music","sP85m3w86Pm45hVYzMi2jgpG6zb.jpg",341605],["Happy Holidays",2010,2.5,1,"Daniel Kwan & Daniel Scheinert","Comedy, Fantasy, Horror","tOdkxYoo1X6Rt3RBENbPqo1Y9WA.jpg",341606],["Tides of the Heart",2009,1.5,1,"Daniel Kwan & Daniel Scheinert","Horror, Comedy, Fantasy","oYV06aX2gcGhckJmWWwIxd2iiDC.jpg",341607],["How to Talk to Girls at Parties",2017,2.5,1,"John Cameron Mitchell","Comedy, Music, Romance, Science Fiction","v6mPfyGshwXd1R6kQlMEyZ8Zu2s.jpg",341689],["Truman",2015,3.5,1,"Cesc Gay","Drama, Comedy","p4MFl06ePJGKMIF7zFCJhex95Vi.jpg",341744],["El tesoro de los caracoles",2004,3,2,"Cristián Jiménez","Comedy","cMBfTRKKspt3F3ySE3ZlzQXUwbc.jpg",341828],["All the Bright Places",2020,2.5,1,"Brett Haley","Romance, Drama","4SafxuMKQiw4reBiWKVZJpJn80I.jpg",342470],["20th Century Women",2016,4,1,"Mike Mills","Drama","mso2rEr9i0MilRIOao5HaWFipS9.jpg",342737],["Este año no hay cosecha",2000,4,1,"Fernando Lavanderos","Documentary","2HB50kg6nX0Wa90UxdQSM2Bfsz6.jpg",343193],["The FrogFish",2007,4.5,1,"José Luis Sepúlveda & Carolina Adriazola","Drama, Mystery, Documentary","dYbg5yh9qJWV6AXMzSKqny9cQUN.jpg",343227],["Somewhere in the Night",2000,2.5,1,"Martín Rodríguez","Drama","4ZRsMpbLcyxjnYznnI8PNVZETfj.jpg",343230],["Kingsman: The Golden Circle",2017,2,1,"Matthew Vaughn","Action, Adventure, Comedy, Crime, Science Fiction","34xBL6BXNYFqtHO9zhcgoakS4aP.jpg",343668],["Limbo: The Organized Mind",1966,3,1,"Jim Henson","Fantasy, Animation","zZKlyrxBzGMlCIISAVyqAfd2va5.jpg",345523],["Lights Out",2016,2,1,"David F. Sandberg","Horror, Mystery","8BnElzAQQpp7ZgdJJiAe1diomr4.jpg",345911],["It",2017,3.5,1,"Andy Muschietti","Horror, Thriller, Drama","9E2y5Q7WlCVNEhP5GiVTjhEhx1o.jpg",346364],["Empirical Study on the Influence of Sound on the Persistence of Vision",2011,2,1,"Denis Villeneuve","Documentary","pCbaR9C8509hBKIAacHgQXUwlNE.jpg",346415],["Paddington 2",2017,4.5,3,"Paul King","Adventure, Comedy, Family","1OJ9vkD5xPt3skC6KguyXAgagRZ.jpg",346648],["The Girl on the Train",2016,2,1,"Tate Taylor","Crime, Mystery, Thriller","AhTO2QWG0tug7yDoh0XoaMhPt3J.jpg",346685],["Barbie",2023,3.5,1,"Greta Gerwig","Comedy, Adventure, Fantasy","iuFNMS8U5cb6xfzi51Dbkovj7vM.jpg",346698],["The Predator",2018,1.5,1,"Shane Black","Science Fiction, Action, Thriller","a3eWGF6YPF7No5Rbtjc8QpDvz7l.jpg",346910],["Swiss Army Man",2016,4.5,2,"Daniel Kwan & Daniel Scheinert","Comedy, Drama, Romance, Fantasy, Adventure","8pxn8CQ6SD6tly75lrKw08wfZKv.jpg",347031],["Pauline",2009,3,1,"Céline Sciamma","Drama","tCM4h1IaDtj9rjjDarXfOk7byVB.jpg",347136],["Ernie Biscuit",2015,2,1,"Adam Elliot","Comedy, Drama, Animation","3sGTOIHZfv0RuMkVNcat6wYyNKn.jpg",347142],["One-Minute Time Machine",2014,2.5,1,"Devon Avery","Mystery, Comedy, Romance","2ff8RRzYNIhcylLfFNbKEc4694C.jpg",347968],["Protect You + Me",2008,3,1,"Brady Corbet","Drama","zglWVg3hmymUoJsXALwXhJ3At58.jpg",347999],["Solo: A Star Wars Story",2018,2,1,"Ron Howard","Science Fiction, Adventure, Action","4oD6VEccFkorEBTEDXtpLAaz0Rl.jpg",348350],["Broomshakalaka",2013,3,1,"Daniel Kwan & Daniel Scheinert","Comedy","uykF3vVrz9tXYtJcKDzKLIk2sk6.jpg",350556],["Jurassic World: Fallen Kingdom",2018,1.5,1,"J. A. Bayona","Adventure, Science Fiction, Thriller, Action","x2Us3jR6ToMJjbcPbLimYoxf6xr.jpg",351286],["Neruda",2016,3,1,"Pablo Larraín","Drama","7WwGjSjEEyP7NrgrI97o3mCezvL.jpg",351454],["Bear Story",2014,3.5,1,"Gabriel Osorio","Animation, Drama","e1jOg4lKOfWmOhfX2hjHpVkGlau.jpg",351981],["Quay",2015,2.5,1,"Christopher Nolan","Documentary","uluMeKfYFVvfZlmHgFBXqbnHXE2.jpg",352114],["From Afar",2015,2.5,1,"Lorenzo Vigas","Drama","iAJDa3lBKCB5YBE9QiXEFSnXNZl.jpg",352162],["Porrada!",2000,2,1,"Eduardo Coutinho","Documentary, Comedy","3PNVxtGjU3WRzcGjI53P0Ndo3hh.jpg",352753],["Mission: Impossible – Fallout",2018,3,2,"Christopher McQuarrie","Action, Adventure","AkJQpZp9WoNdj7pLYSj1L0RcMMN.jpg",353081],["Jumanji: Welcome to the Jungle",2017,2.5,1,"Jake Kasdan","Adventure, Comedy, Fantasy","pSgXKPU5h6U89ipF7HBYajvYt7j.jpg",353486],["Pitch Perfect 3",2017,2,1,"Trish Sie","Music, Comedy","v4tbRRX0OSOHcgz2869rEjcBwOJ.jpg",353616],["Road Signs",2000,4,1,"Tevo Díaz","Documentary","5za3hsbbnFFkHfauBi8U63jHLUp.jpg",353799],["Guardians",2017,1,1,"Sarik Andreasyan","Science Fiction, Action, Fantasy, Comedy, Thriller","sGHAoGdxD9CeJxr1mvKHjgt8eqj.jpg",354556],["Coco",2017,4.5,1,"Lee Unkrich","Family, Animation, Music, Adventure","6Ryitt95xrO8KXuqRGm1fUuNwqF.jpg",354912],["m.A.A.d",2014,4,1,"Kahlil Joseph","Music, Drama","lCOw2nEhMWtyKzCQpvP5lL31Vhr.jpg",354969],["I Dream in Another Language",2017,3,1,"Ernesto Contreras","Fantasy, Drama","tUEhleHFj47f84qd3tCrzQvLbpu.jpg",355196],["De Palma",2015,3.5,1,"Noah Baumbach","Documentary","uYYxSGwKWrnN86Uyuk0NyDzCLwh.jpg",355254],["Riley's First Date?",2015,2.5,1,"Josh Cooley","Animation, Family","cGLwfmLqg39822RFQMUDat0UJev.jpg",355338],["Horse Shoeing",1893,2,1,"William K.L. Dickson & William Heise","Documentary, Drama","4uhV7MGOPOEYgCTCLmmGzW6roTM.jpg",355533],["Junun",2015,2.5,1,"Paul Thomas Anderson","Music, Documentary","tsssow8XqZgP6KhT39Shx45sWBK.jpg",355600],["Hyde Park Corner",1889,2,1,"William Friese-Greene","Documentary","uhwSD8ycp4FYtvUJywCp3Sv1efO.jpg",355764],["Mimbre",1958,3,1,"Sergio Bravo","Documentary","",357812],["The Fits",2015,3,1,"Anna Rose Holmer","Drama","ujK85shn2lY3yJrleXa8wThgVrI.jpg",358807],["Testimony",1969,2.5,1,"Pedro Chaskel","Documentary","",358942],["Ford v Ferrari",2019,3.5,1,"James Mangold","Drama, History, Action","dR1Ju50iudrOh3YgfwkAU1g2HZe.jpg",359724],["78/52",2017,3.5,1,"Alexandre O. Philippe","Documentary","mJb3OTY0rc4dTUStQnxSeRacsTV.jpg",359749],["Three Billboards Outside Ebbing, Missouri",2017,4.5,2,"Martin McDonagh","Crime, Drama","bRYLt8fV82tdVoDppSFTZIcJiLN.jpg",359940],["Lo and Behold: Reveries of the Connected World",2016,3.5,1,"Werner Herzog","Documentary","yv9ecMFec43ReHGy1fDntPF4FS2.jpg",360030],["Dangal",2016,3.5,1,"Nitesh Tiwari","Drama, Family, Comedy","cJRPOLEexI7qp2DKtFfCh7YaaUG.jpg",360814],["Suspiria (2018)",2018,4,1,"Luca Guadagnino","Horror, Mystery, Drama","xP63I4ulHl7DKInxL9cS1b15wNq.jpg",361292],["Ellis",2015,3,1,"JR","Drama","v0lbu4CZ24ULisPoHpFXkN1qyAD.jpg",361671],["Top Gun: Maverick",2022,4,1,"Joseph Kosinski","Action, Drama","62HCnUTziyWcpDaBO2i1DX17ljH.jpg",361743],["Doc Brown Saves the World",2015,2,1,"Robert Zemeckis","Science Fiction","863sDCCKgXaLkXZL0yzmC9lokel.jpg",362000],["Ant-Man and the Wasp",2018,2,1,"Peyton Reed","Action, Adventure, Science Fiction","cFQEO687n1K6umXbInzocxcnAQz.jpg",363088],["Sully",2016,3,1,"Clint Eastwood","Drama, History","4vs83YcJ8TsabADDtaeCJ6ZTjYY.jpg",363676],["Surire",2015,4,1,"Bettina Perut & Iván Osnovikoff","Documentary","hTzS5274sleCMS59RhDHFo4Wm5M.jpg",363688],["The Above",2015,2.5,1,"Kirsten Johnson","Documentary","cfvpIVfUyEw6lBq0USuGUjUFx1c.jpg",363723],["The Innocents (2016)",2016,3,1,"Anne Fontaine","Drama, History","8ZSPkyzq80jBVezRlC80kvV6QZr.jpg",364051],["A Very Murray Christmas",2015,2,1,"Sofia Coppola","Comedy, Music, TV Movie","2ir2DjNNXmMePsyc4inFa8oI23r.jpg",364067],["11 Episodios Sinfónicos",2002,3,1,"Alejandro Terán","Music","x1802VEY6Ij3Jz0sMecdlIpv2g9.jpg",365130],["The Audition",2015,2,1,"Martin Scorsese","Comedy","t1PDIeDpJGgI9JPqIRMuG7WDdId.jpg",365717],["The Neighborhood",2001,3,1,"Martin Scorsese","Documentary","usIRntkWyvJYj2Vz5qtf13ahTnQ.jpg",366294],["Whiplash (2013)",2013,3,1,"Damien Chazelle","Drama, Music","2yQkiGAmztaBkGLjVIrHUYHTex5.jpg",367412],["Don't Hug Me I'm Scared 5",2015,4,2,"Becky Sloan & Joseph Pelling","Horror, Animation, Fantasy, Music, Comedy","lF2sWrHygrIoBVD824ockV2ruku.jpg",368051],["Heart",2010,2.5,1,"Erick Oh","Animation","14vNourR6hVTwIZ3JZvf84kT9vh.jpg",368938],["Battle of the Sexes",2017,2.5,1,"Jonathan Dayton & Valerie Faris","Drama, Comedy, History","fWy0A3VojTCb0S2MKtEJjpquubF.jpg",369192],["Sing Street",2016,4.5,2,"John Carney","Romance, Drama, Music, Comedy","sUWpVlrvzU2SJbnVZqIeKulPKwk.jpg",369557],["Marcel the Shell with Shoes On (2010)",2010,3,1,"Dean Fleischer Camp","Comedy, Animation","q6C6JLUm8Yb0oaFYJiic025AArR.jpg",369800],["First Man",2018,3.5,1,"Damien Chazelle","History, Drama","i91mfvFcPPlaegcbOyjGgiWfZzh.jpg",369972],["Chicago Boys",2015,3.5,1,"Carola Fuentes","Documentary","1MUTsl25gWI9pTk8DHKQbNqd5y8.jpg",370168],["No Time to Die",2021,4,1,"Cary Joji Fukunaga","Action, Thriller, Adventure","iUgygt3fscRoKWCV1d0C7FbM9TP.jpg",370172],["Paterson",2016,4.5,1,"Jim Jarmusch","Drama, Comedy, Romance","AuJ1ZlfqwuAr9H5Qr1U9KILylse.jpg",370755],["The Fly (2014)",2014,2.5,1,"Olly Williams","Comedy, Crime","",371297],["Lovesong",2016,2.5,1,"So Yong Kim","Drama, Romance","43yEeZbFeFOah9mZWIIJe57STKS.jpg",371447],["Other People",2016,3,1,"Chris Kelly","Comedy, Drama","3JgG3p4FY0fNSgJneNWnVno7X9j.jpg",371449],["Much Ado About Nothing (2016)",2016,3,1,"Alejandro Fernández Almendras","Drama","sltBvNQGWY3Jnpecy4kbRxJ17v5.jpg",371465],["The Disaster Artist",2017,3,1,"James Franco","Comedy, Drama","2HuLGiyH0TPYxnCvYHAxc8K738o.jpg",371638],["Hunt for the Wilderpeople",2016,3.5,1,"Taika Waititi","Adventure, Comedy, Drama","hkmz9rxgcweizXNElozGeKwmAJE.jpg",371645],["Your Name.",2016,4,1,"Makoto Shinkai","Animation, Romance, Drama","q719jXXEzOoYaps6babgKnONONX.jpg",372058],["The Expropriation",1974,2.5,1,"Raúl Ruiz","Drama","",372201],["The Snowman",2017,1,1,"Tomas Alfredson","Crime, Thriller, Mystery, Horror","mKsQ8KMOk0VBX26Ev0Lj6EmfGJu.jpg",372343],["Tickled",2016,3.5,1,"David Farrier","Documentary","qxUbPwyhzNEyUZYOZm6t8yYSQf.jpg",373072],["Godzilla: King of the Monsters",2019,2,1,"Michael Dougherty","Science Fiction, Action","mzOHg7Q5q9yUmY0b9Esu8Qe6Nnm.jpg",373571],["Print Your Guy",2015,1,1,"","Animation","",373630],["The Love Witch",2016,3.5,1,"Anna Biller","Horror, Comedy, Romance, Fantasy","fVxkSy5pAhNkwwFcJNbQZwlD3pt.jpg",374052],["Blue Bayou",1946,2.5,1,"Samuel Armstrong","Animation","7jSdnYiFmbZGRkiYFteryeEdu34.jpg",374447],["Things to Come",2016,3,1,"Mia Hansen-Løve","Drama","6MAAJJ51y2RUa1gvvVje4s0FB7W.jpg",374465],["I, Daniel Blake",2016,4,1,"Ken Loach","Drama","nu3WVABXz2W85N6JXTZOT1aWS3b.jpg",374473],["Toni Erdmann",2016,3.5,1,"Maren Ade","Comedy, Drama","v3gf7T8hb8aYv05X2jHmxJQWPZr.jpg",374475],["After the Storm",2016,3.5,1,"Hirokazu Kore-eda","Drama","oScZQ3ZVvnVtgZpuFW75msSVmHC.jpg",374671],["Dunkirk",2017,4,2,"Christopher Nolan","War, Action, Drama","b4Oe15CGLL61Ped0RAS9JpqdmCt.jpg",374720],["Yuki's Sun",1972,2.5,1,"Hayao Miyazaki","Animation, Drama","cLQKaxGQkgG8G9F9o4DGX9Z0zuf.jpg",375079],["The Favourite",2018,5,2,"Yorgos Lanthimos","History, Comedy, Drama","cwBq0onfmeilU5xgqNNjJAMPfpw.jpg",375262],["The Fairly OddParents: Channel Chasers",2004,3.5,1,"Butch Hartman","TV Movie, Adventure, Animation, Comedy, Family, Fantasy","fJcC7gsQ7oEIDRd0e0fsVEhcSPU.jpg",375273],["The Salesman",2016,3.5,1,"Asghar Farhadi","Drama, Thriller","x4PIuYU5ZMMXiTrheNR8vCTYPBf.jpg",375315],["Life, Animated",2016,3.5,1,"Roger Ross Williams","Documentary","dAbgluMr621IDx0fvyzVOYtAhEX.jpg",376233],["Cameraperson",2016,3,1,"Kirsten Johnson","Documentary","p1Od99QxnzCB9vKu9uxkZQlPZQ5.jpg",376534],["Hush",2016,2.5,1,"Mike Flanagan","Horror, Thriller","tyqD4C2vVKrvP3FkFK0GS9IWbTo.jpg",376570],["Fishmans: Otokotachi no Wakare 98.12.28 @ Akasaka Blitz",2005,4.5,1,"Kensuke Kawamura","Music","qhvniVor7eGvNpceewNQqkhDzXp.jpg",376644],["The Edge of Seventeen",2016,3.5,1,"Kelly Fremon Craig","Comedy, Drama","iY5UEYuGxHfaYJ3vAUAWwFGMV7V.jpg",376660],["High Life",2018,3,1,"Claire Denis","Science Fiction, Drama, Mystery","ftRRIYNzpTDYeTznrAxgT5v1vJY.jpg",376865],["Jackie",2016,4,1,"Pablo Larraín","Drama","nF9N33PfhizMEzbfxHoxXBo2vx9.jpg",376866],["Moonlight",2016,4.5,2,"Barry Jenkins","Drama","qLnfEmPrDjJfPyyddLJPkXmshkp.jpg",376867],["Aquarius",2016,3,1,"Kleber Mendonça Filho","Drama","9hwkjmtl3HCXe7JW2BVSyjLXHCo.jpg",377273],["In Bed with Victoria",2016,3.5,1,"Justine Triet","Comedy, Drama, Romance","fEt9U7JQYO8j8VtCCuyDzznPM2x.jpg",377275],["Void",2017,2.5,1,"Emma Seligman","Mystery, Horror, Science Fiction","2WhZAPi3vomEQdzAPIYTvmvWaxI.jpg",378018],["A Silent Voice: The Movie",2016,4.5,1,"Naoko Yamada","Animation, Drama, Romance","tuFaWiqX0TXoWu7DGNcmX3UW7sT.jpg",378064],["The Emoji Movie",2017,0.5,1,"Tony Leondis","Animation, Family, Comedy","60bTx5z9zL1AqCjZ0gmWoRMJ6Bb.jpg",378236],["1943-1997",1997,4,1,"Ettore Scola","Drama","18h49oAV2JmAO2wQ2j343gedFfj.jpg",378387],["Alba",2016,2.5,1,"Ana Cristina Barragán","Drama","ZLEGZZlC2RPdNNWYiF5Xl2zA9d.jpg",378396],["Sherlock: The Abominable Bride",2016,2.5,1,"Douglas Mackinnon","Crime, Drama, Mystery, Thriller, TV Movie","hibE8cyZs2Bm0o4WaWd1pppvjO2.jpg",379170],["No Filter",2016,1,1,"Nicolás López","Comedy","cISuCIaPdwjJ8YJhBipdslltKl9.jpg",379220],["Space Jam: A New Legacy",2021,1,1,"Malcolm D. Lee","Family, Comedy, Adventure, Animation, Science Fiction","5bFK5d3mVTAvBCXi5NPWH0tYjKl.jpg",379686],["mother!",2017,4,1,"Darren Aronofsky","Horror, Drama","fjny9chXPx69ln1LMJxbwi5yHMt.jpg",381283],["Hidden Figures",2016,2,1,"Theodore Melfi","Drama, History","9lfz2W2uGjyow3am00rsPJ8iOyq.jpg",381284],["Split",2016,2.5,1,"M. Night Shyamalan","Horror, Thriller","lli31lYTFpvxVBeFHWoe5PMfW5s.jpg",381288],["Perfect Strangers",2016,3,1,"Paolo Genovese","Drama","3wknM629Vryofb1HNo2YnLQnQyn.jpg",381341],["Shrek the Musical",2013,2.5,1,"Michael John Warren","Comedy, Fantasy, Family, Romance, Adventure","wRvMRdLa8zQ85drGAWEsZTuKJO.jpg",381696],["The Mermaid",2016,2,1,"Stephen Chow","Comedy, Fantasy, Romance","8YVB8VxQqx3J1FtOVvoHybBKNPS.jpg",381890],["Don't Look Back, My Son",1956,2.5,1,"Branko Bauer","War, Drama, Thriller","1wlceMhSuLnIlnund06sgW4XTEr.jpg",381992],["Don't Call Me Son",2016,3.5,1,"Anna Muylaert","Drama","79LUuQUy3hgJKjxR00ZFqUY1D3B.jpg",382455],["Rara",2016,3,1,"Pepa San Martín","Drama","zsgx02RjFAxGuG9X9KvzxkzFwbk.jpg",382906],["Deadpool 2",2018,3,1,"David Leitch","Action, Comedy, Adventure","to0spRl1CMDvyUbOnbb4fTk3VAd.jpg",383498],["The Tell-Tale Heart",2008,3,1,"Robert Eggers","Horror, Crime","yLs44Sx08WAHhgvnh0XIg7s5e9F.jpg",383802],["Fast & Furious Presents: Hobbs & Shaw",2019,2,2,"David Leitch","Action, Adventure, Comedy","qRyy2UmjC5ur9bDi3kpNNRCc5nc.jpg",384018],["The Cloverfield Paradox",2018,1,1,"Julius Onah","Horror, Mystery, Science Fiction","vJi2ExTcWdJR3150VPKqqtdGxsT.jpg",384521],["F9",2021,2.5,1,"Justin Lin","Action, Adventure, Crime","deEmLILTPejEb6OGsXRJ5MCvyDW.jpg",385128],["Family Remains",1993,3,1,"Tamara Jenkins","","1Fp9imyPDwOkH65EWnyEx76OZnV.jpg",385632],["Okja",2017,3,1,"Bong Joon Ho","Adventure, Drama, Science Fiction, Action","lHBYG2NcBMW7UpFL4rSCpsgvz4m.jpg",387426],["Early Man",2018,1.5,1,"Nick Park","Family, Comedy, Animation, Adventure","5iW2rntwLZoGlFCYYy8TjHyblbw.jpg",387592],["The Way I Like It",1985,3.5,1,"Ignacio Agüero","Documentary","9w9GKJYCy2pAERyKAaZGU0LKbq6.jpg",387705],["I, Tonya",2017,3,1,"Craig Gillespie","Drama, Comedy","6gNXwSHxaksR1PjVZRqNapmkgj3.jpg",389015],["Bloody Nitrate",1969,3,1,"Helvio Soto","Drama","69piKjjsGerLkTJteWhtcYrjz2n.jpg",389172],["Lucía",2007,3,1,"Cristóbal León & Joaquín Cociña","Animation, Horror, Drama","wnDFJMYG2MpJ1RaJpmmccaVzhiJ.jpg",389645],["Luis",2008,3,1,"Cristóbal León & Joaquín Cociña","Animation, Horror, Drama","4AMv5Z2WY85lhqgv1fX3kLZ5P1u.jpg",389647],["Lady Bird",2017,4.5,3,"Greta Gerwig","Drama, Comedy","gl66K7zRdtNYGrxyS2YDUP5ASZd.jpg",391713],["Seed",2016,2.5,1,"Naomi Kawase","Music","xRt3VqwxFLl07z7nE0NxM5Ll3bf.jpg",391864],["Kedi",2016,3.5,1,"Ceyda Torun","Documentary","o7SB4YELcuVGUMIXeunWZ8rbx4h.jpg",392011],["Murder on the Orient Express (2017)",2017,2,1,"Kenneth Branagh","Mystery, Drama, Crime","7GtdJU6iAg6fjQu3E3zta3bIAQh.jpg",392044],["Enough Praying",1972,4,1,"Aldo Francia","Drama","1CtBiHBxtxHzSzSKF9p05xaATLP.jpg",392459],["Fences",2016,3,1,"Denzel Washington","Drama","8NvnB8aeWQvBEz2ruN4g313j991.jpg",393457],["Raw",2016,4,1,"Julia Ducournau","Horror, Drama","kc8jT1MAiKM0iwdjAwC5lQrTNry.jpg",393519],["My Life as a Zucchini",2016,3.5,1,"Claude Barras","Animation, Comedy, Drama","2uu8fIzl76C9MFiUQhjKYSLKVq.jpg",393559],["The Florida Project",2017,4.5,2,"Sean Baker","Drama","bnSTP1PY2fDyat0eUa4QouuGV7F.jpg",394117],["At the End of the Tunnel",2016,3,1,"Rodrigo Grande","Crime, Thriller","gKfm5UqRwvoNiImFQLEH2WDMK5S.jpg",394374],["Wind River",2017,3.5,1,"Taylor Sheridan","Crime, Mystery, Thriller","pySivdR845Hom4u4T2WNkJxe6Ad.jpg",395834],["Life",2017,2,1,"Daniel Espinosa","Horror, Science Fiction, Mystery","wztfli5NgYDgurVgShNflvnyA3Z.jpg",395992],["Stronger",2017,2.5,1,"David Gordon Green","Drama","nnkxdFeY7YAgnicxkvwuxY7gVaT.jpg",395993],["Molly's Game",2017,3,1,"Aaron Sorkin","Drama, Crime","zrGQwKNmAz5awZI2V1k5M4eTTTN.jpg",396371],["The Meyerowitz Stories (New and Selected)",2017,3.5,1,"Noah Baumbach","Comedy, Drama","c9teDTgwxgnb7wnZjZo4oNcF80R.jpg",396398],["Under the Silver Lake",2018,4,1,"David Robert Mitchell","Crime, Drama, Mystery","771Ey73LqsE9ORJhQCI25rgMXS2.jpg",396461],["A. K.",1985,3.5,1,"Chris Marker","Documentary","jEogjj5O7e9F2UYZSF6Ib3cb9Lh.jpg",396485],["Train to Busan",2016,3,1,"Yeon Sang-ho","Action, Horror, Thriller","vNVFt6dtcqnI7hqa6LFBUibuFiw.jpg",396535],["Pieta (1999)",1999,2.5,1,"Joachim Trier","Drama","auo9D93BaL3crQnD41iuW8j5FCj.jpg",396634],["Anon",2018,1,1,"Andrew Niccol","Science Fiction, Crime, Mystery, Thriller","xhBTO9n3fxy3HJt7WlR9h9vvVmk.jpg",396806],["Rough Night",2017,1,1,"Lucia Aniello","Drama, Comedy","ttC00xcQ5UIO04kU8y0h5OAIYYJ.jpg",397422],["The Smaller Room",2009,3,1,"Cristóbal León & Joaquín Cociña","Animation, Horror","6bWAKwfFmnW6BB6ZEjk6SeMYaRR.jpg",397459],["Thoroughbreds",2017,3.5,1,"Cory Finley","Drama, Thriller","dBhskn3zQZu1DKy1ZjjmJRxJUxm.jpg",397722],["Brothers",2014,2.5,1,"Jim Sheridan","Drama","8CbDY9GIDkFUkS8Bdr254s25JqD.jpg",397805],["You Were Never Really Here",2017,3.5,1,"Lynne Ramsay","Crime, Drama, Thriller","nx4lUyQNEzJowcF55VAP0TQEaX0.jpg",398181],["Call Me by Your Name",2017,4,3,"Luca Guadagnino","Romance, Drama","mZ4gBdfkhP9tvLH1DO4m4HYtiyi.jpg",398818],["The Irishman",2019,4.5,1,"Martin Scorsese","Crime, Drama, History","mbm8k3GFhXS0ROd9AD1gqYbIFbM.jpg",398978],["The Beguiled",2017,4,1,"Sofia Coppola","Drama","x4R9jyiZhJzevASus5n6WyHQTdR.jpg",399019],["Happy End",2017,3,1,"Michael Haneke","Drama","tAHzP9O0MOswvWFv5jtWGTyMYXl.jpg",399031],["The Shape of Water",2017,4.5,3,"Guillermo del Toro","Drama, Fantasy, Romance","9zfwPffUXpBrEP26yp0q1ckXDcj.jpg",399055],["The Killing of a Sacred Deer",2017,4,1,"Yorgos Lanthimos","Drama, Thriller, Mystery","e4DGlsc9g0h5AyoyvvAuIRnofN7.jpg",399057],["Piper",2016,3.5,1,"Alan Barillaro","Family, Animation","5fu2d809jepLwEpES7wggiECLoQ.jpg",399106],["Logan Lucky",2017,3.5,1,"Steven Soderbergh","Comedy, Crime, Action, Drama","mQrhrBaaHvRfBQq0Px3HtVbH9iE.jpg",399170],["Lucky",2017,3.5,1,"Steven Soderbergh","Comedy, Crime, Action, Drama","mQrhrBaaHvRfBQq0Px3HtVbH9iE.jpg",399170],["Isle of Dogs",2018,4,1,"Wes Anderson","Adventure, Comedy, Animation","c0nUX6Q1ZB0P2t1Jo6EeFSVnOGQ.jpg",399174],["Triple Frontier",2019,2.5,1,"J.C. Chandor","Action, Thriller, Crime, Adventure","aBw8zYuAljVM1FeK5bZKITPH8ZD.jpg",399361],["Darkest Hour",2017,2.5,1,"Joe Wright","Drama, History","xa6G3aKlysQeVg9wOb0dRcIGlWu.jpg",399404],["Godzilla vs. Kong",2021,2.5,1,"Adam Wingard","Action, Science Fiction, Adventure","pgqgaUx1cJb5oZQQ5v0tNARCeBp.jpg",399566],["Alita: Battle Angel",2019,3,1,"Robert Rodriguez","Action, Science Fiction, Adventure","xRWht48C2V8XNfzvPehyClOvDni.jpg",399579],["Tully",2018,3.5,1,"Jason Reitman","Comedy, Drama","wDI4YXBXolMYi15Qx2kClvdSERM.jpg",400579],["Bo Burnham: Make Happy",2016,4.5,4,"Bo Burnham","Comedy, Music","qVThhskXZZHDfj4m8jOx2CxIVIW.jpg",400608],["Phantom Thread",2017,4.5,1,"Paul Thomas Anderson","Drama, Romance","hgoWjp9Sh0MI97eAMZCnIoVfgvq.jpg",400617],["Mary Poppins Returns",2018,2.5,1,"Rob Marshall","Fantasy, Family, Comedy","uTVGku4LibMGyKgQvjBtv3OYfAX.jpg",400650],["After Hitler",2016,3,1,"David Korn-Brzoza","Documentary, History","aMWhEZTYcdQmsQNbKGBKlPBv5nB.jpg",400875],["The Square",2017,4,1,"Ruben Östlund","Drama","pefcv5VNspSK4Dt8doei5bJmmln.jpg",401246],["Mute",2018,1,1,"Duncan Jones","Science Fiction, Mystery, Thriller","ihGg1xndLl3MW34Km332pNkyLH7.jpg",401371],["Widows",2018,3.5,1,"Steve McQueen","Drama, Crime, Thriller","d31SGJSaX29ba5ZUbZcesGoDE7I.jpg",401469],["Everybody Knows",2018,3.5,1,"Asghar Farhadi","Crime, Mystery, Thriller","1TuuM451os3NaltCwGfPCVL2BST.jpg",401545],["Can You Ever Forgive Me?",2018,3,1,"Marielle Heller","Drama, Crime, Comedy","y9pDvBdvU8Z5QjQ6Y4oF0Cq7p5j.jpg",401847],["Thelma",2017,3.5,1,"Joachim Trier","Drama, Mystery, Thriller","gQSUVGR80RVHxJywtwXm2qa1ebi.jpg",401898],["Wicked",2024,2.5,1,"Jon M. Chu","Drama, Romance, Fantasy","xDGbZ0JJ3mYaGKy4Nzd9Kph6M9L.jpg",402431],["Don't Hug Me I'm Scared 6",2016,4.5,2,"Becky Sloan & Joseph Pelling","Animation, Horror, Music, Fantasy, Comedy","n9z1eVpRxzC88Qr3SYf6c7Y8tgM.jpg",402871],["The Death of Stalin",2017,2.5,1,"Armando Iannucci","Comedy, Drama, History","AqH7q89NxGRDAyRWKqsL3OBtYfV.jpg",402897],["Ocean's Eight",2018,2,1,"Gary Ross","Crime, Comedy, Action","MvYpKlpFukTivnlBhizGbkAe3v.jpg",402900],["Hidden",2020,3,1,"Jafar Panahi","History, Drama, War","rdG4jfH0rxkB2FgkYmjj9V4Q31M.jpg",403300],["Brigsby Bear",2017,3.5,1,"Dave McCary","Comedy, Drama","9QepAxHR9am4nKWZqIDpIQjuB5.jpg",403431],["Ralph Breaks the Internet",2018,2.5,1,"Rich Moore","Action, Adventure, Animation, Comedy, Family, Science Fiction","iVCrhBcpDaHGvv7CLYbK6PuXZo1.jpg",404368],["Where'd You Go, Bernadette",2019,2.5,1,"Richard Linklater","Comedy, Drama","BziuuZULnGmTRLthEty1QdKSEo.jpg",405177],["Bird Box",2018,1,1,"Susanne Bier","Horror, Thriller, Drama","rGfGfgL2pEPCfhIvqHXieXFn7gp.jpg",405774],["I'm Not From Here",2016,3,1,"Maite Alberdi","Documentary","mzJdUHE03dBz2CInhNK10qJHYdb.jpg",406029],["Sea-Mail",2007,2.5,1,"Víctor Erice","Drama","8yI7WoGB88ZiznWZ7Jqys785X13.jpg",406399],["Inner Workings",2016,3,1,"Leo Matsuda","Animation, Family, Comedy","vUZqG2SvTkAlMVlzARXaMNCYMuk.jpg",406785],["Mowgli: Legend of the Jungle",2018,1,1,"Andy Serkis","Adventure, Drama","clRnzMsFoMIdC7I5JsG6dnnHH8l.jpg",407436],["A Wrinkle in Time",2018,1,1,"Ava DuVernay","Adventure, Science Fiction, Family, Fantasy","yAcb58vipewa1BfNit2RjE6boXA.jpg",407451],["13th",2016,3.5,1,"Ava DuVernay","Documentary","tcKNWD6IFPPsvkpvyZ548naz0is.jpg",407806],["Game Over",2006,3.5,1,"PES","Action, Drama","asSR8qWRWPo3zR8q1OmiKBhDgcw.jpg",409500],["Lady Macbeth",2016,3.5,1,"William Oldroyd","Drama","xWTJbhTwSTJmhLlX5xAOxPhdnXc.jpg",410117],["Possibilia",2014,3.5,1,"Daniel Kwan & Daniel Scheinert","","lovBiA1mAUy7T951rbJXFm6ehQW.jpg",410631],["I Am Not Your Negro",2016,4,1,"Raoul Peck","Documentary","zwd0Zti7BvY1mO0mTPzM0fRrtc6.jpg",411019],["Ingrid Goes West",2017,3.5,1,"Matt Spicer","Comedy, Drama","3LEyW11onDltXHo0L1X23j9Nnvg.jpg",411741],["The Wedding Party",2016,0.5,1,"Kemi Adetiba","Comedy, Romance","qJpP0QJZE1Lcxswchana8opO9uW.jpg",412196],["Supersonic",2016,2.5,1,"Mat Whitecross","Music, Documentary, History","gMHLEKTB22J212To1gSnundcIhH.jpg",412924],["Team Thor",2016,3.5,1,"Taika Waititi","Comedy, Science Fiction","jVSmX89BvsQV2z3wh2IVYVNVw1a.jpg",413279],["Pinocchio (2019)",2019,3,1,"Matteo Garrone","Drama, Family, Fantasy","9c3EG58062cl5zjBqSkDhoKIOtD.jpg",413518],["Juan Gabriel en el Palacio de Bellas Artes",1990,4.5,1,"Benjamín Estavillo","Music, Documentary","9UI1ekWPHt7N3bn2m1XvkN5hms6.jpg",413678],["David Lynch: The Art Life",2016,3,1,"Jon Nguyen","Documentary","pgtQceTZKylB2B237t18h2pOXpE.jpg",413765],["Lost in Paris",2016,1.5,1,"Fiona Gordon","Comedy","8XVNkOslnv5Atxy47RfPUtTDBkH.jpg",413778],["Mifune: The Last Samurai",2015,3.5,1,"Steven Okazaki","Documentary","nklWhTBnbFw0NutlupxNbDB9TZZ.jpg",413782],["Mudbound",2017,3.5,1,"Dee Rees","Drama","tf21kSKepMOlnorszWaiFwksKU4.jpg",414425],["Columbus",2017,4,1,"Kogonada","Drama","6tk0xmn9k5HjUeXsnhxIa94sFXP.jpg",414453],["The Batman",2022,4.5,1,"Matt Reeves","Crime, Mystery, Thriller","74xTEgt7R36Fpooo50r9T25onhq.jpg",414906],["The Big Sick",2017,3.5,1,"Michael Showalter","Comedy, Drama, Romance","9fJTT8pBxxQsFILJHTtHhdYFr77.jpg",416477],["Chit Chat with Oysters",2013,3.5,1,"Adrian Maben","Music, Documentary","zUXwzmuNkLY9izoksvm7Qud3XAB.jpg",416974],["The Escape",2016,2.5,1,"Neill Blomkamp","Thriller, Action, Drama, Science Fiction","nKm8oOyjC88l0Iggwuye4ayMvWF.jpg",417004],["Monos",2019,4,1,"Alejandro Landes Echavarría","Drama, Thriller, Crime, War","sMcvyEqzwWyaUhuUaJtiZuc7Ku5.jpg",417466],["Wildlife",2018,3.5,1,"Paul Dano","Drama","hQSUwjSSRtWCA5EBoY22gGzaE8Y.jpg",417812],["Puss in Boots",2011,2,1,"Chris Miller","Action, Adventure, Animation, Comedy, Family","7a5Jzjr9TmffGy76y1SZhn3sCiz.jpg",417859],["It Comes at Night",2017,2.5,1,"Trey Edward Shults","Drama, Horror, Mystery","rNKJpFMlOZn5zkzBPZxEJrQn5Km.jpg",418078],["Get Out",2017,4,1,"Jordan Peele","Mystery, Thriller, Horror","tFXcEccSQMf3lfhfXKSU9iRBpa3.jpg",419430],["Marcel the Shell with Shoes On, Two",2011,3,1,"Dean Fleischer Camp","Comedy, Animation","43DYs0mWeQAXXB1wilx5QBz2XrC.jpg",419468],["The Polka King",2017,2.5,1,"Maya Forbes","Comedy","wJXC652ZGCnpDSn94kcucdplKYC.jpg",419472],["Marcel the Shell with Shoes On, Three",2014,3,1,"Dean Fleischer Camp","Comedy, Animation","2cYCWXDnvDIc7PiCOpXIfOf2uyu.jpg",419474],["Limbos",2014,3.5,1,"Mike Cheslik","Horror, Comedy, Romance","owyHeQSMSBf7YvViNbx06TXfK8z.jpg",419620],["Ad Astra",2019,4.5,1,"James Gray","Science Fiction, Drama","xBHvZcjRiWyobQ9kxBhO6B2dtRI.jpg",419704],["Disobedience",2017,3.5,1,"Sebastián Lelio","Drama, Romance","skPT4ffWhlmmDOMNEdxOiP6Emfz.jpg",419743],["Como me da la gana II",2016,2.5,1,"Ignacio Agüero","Documentary","cp1Ft9hiKOxgiTLCC2mtVAwTjQB.jpg",420359],["The Bar",2017,2.5,1,"Álex de la Iglesia","Horror, Thriller, Comedy","vYyALnKnzHLv4PoU2b447GYT8R9.jpg",420648],["Maleficent: Mistress of Evil",2019,1.5,1,"Joachim Rønning","Family, Fantasy, Adventure","vloNTScJ3w7jwNwtNGoG8DbTThv.jpg",420809],["Robin Robin",2021,3,1,"Marc Forster","Adventure, Comedy, Family, Fantasy","i6Ytex4d3CdfIKJFxB5v5vh24vb.jpg",420814],["Aladdin (2019)",2019,1.5,1,"Guy Ritchie","Adventure, Fantasy, Romance, Family","eLFfl7vS8dkeG1hKp5mwbm37V83.jpg",420817],["Chip 'n Dale: Rescue Rangers",2022,2.5,1,"Akiva Schaffer","Animation, Family, Comedy, Adventure, Mystery","7UGmn8TyWPPzkjhLUW58cOUHjPS.jpg",420821],["Borrowed Time",2015,3.5,1,"Andrew Coats","Animation, Drama, Western","p2FoxeUWAKwS9LbCzXszfV2er4j.jpg",421281],["Bad Influence",2016,3,1,"Claudia Huaiquimilla","Comedy, Drama","ITrHmxHNOBfnKfDfkuj1lusSVr.jpg",421883],["7 Weeks",2016,3,1,"Constanza Figari","Drama","sfLijtKkiBjAJTgIhEc9gl15nJO.jpg",421938],["A Man Aside",2001,3.5,1,"Bettina Perut & Iván Osnovikoff","Documentary","sx684auQFyUuNdSXLRNzn5Y3Ix.jpg",422736],["Los deseos concebidos",1982,3,1,"Cristián Sánchez","Drama","l4CH0QUaRTrOD63n1Tq7DVNCzyW.jpg",422739],["Day of the Organ Grinders",1961,3,1,"Sergio Bravo","Documentary","",422749],["El otro round",1984,2,1,"Cristián Sánchez","Comedy, Drama","5htWKzp5VFLxutjcJZIUPsHiz5I.jpg",422752],["Noticias",2009,2,1,"Bettina Perut & Iván Osnovikoff","Documentary","q1phLi5YjHByF8Vu7fUhIRuZKZm.jpg",422762],["The Skinny Alejandra",1994,3.5,1,"Guy Girard","Documentary","t3pUoHD2quQ0JDwnse7phIqjoxc.jpg",422776],["A Shaun the Sheep Movie: Farmageddon",2019,2.5,1,"Will Becher","Family, Comedy, Adventure, Animation, Science Fiction","p08FoXVFgcRm5QZBaGj0VKa2W2Y.jpg",422803],["The Conjuring: The Devil Made Me Do It",2021,2.5,1,"Michael Chaves","Horror, Mystery, Thriller","xbSuFiJbbBWCkyCCKIMfuDCA4yV.jpg",423108],["Mass",2021,4,1,"Fran Kranz","Drama","c3MQ3YZKJadrH2Yv45i07qMHGPM.jpg",423333],["The Scooby-Doo Project",1999,3.5,1,"Casper Kelly","Animation, Mystery, Horror, Comedy, TV Movie","9n19VxFLUXgOFM008Pbc19q7lUf.jpg",423336],["Unicorn Store",2017,2,1,"Brie Larson","Fantasy, Drama, Comedy","rGe3eWy3F3qggDZMc86bASN4I7C.jpg",423949],["Halloween (2018)",2018,3.5,2,"David Gordon Green","Horror, Thriller","f7JAX5EGk4GgsEnus6OxyzwpFp7.jpg",424139],["Annette",2021,3,1,"Leos Carax","Drama, Romance","4FTnypxpGltJdIARrfFsP31pGTp.jpg",424277],["Bohemian Rhapsody",2018,3,1,"Bryan Singer","Music, Drama","lHu1wtNaczFPGFDTrjCSzeLPTKN.jpg",424694],["Sorry to Bother You",2018,4,1,"Boots Riley","Fantasy, Science Fiction, Comedy","peTl1V04E9ppvhgvNmSX0r2ALqO.jpg",424781],["Bumblebee",2018,2.5,1,"Travis Knight","Action, Adventure, Science Fiction","fw02ONlDhrYjTSZV8XO6hhU3ds3.jpg",424783],["The War with Grandpa",2020,0.5,1,"Tim Hill","Comedy, Family","ltyARDw2EFXZ2H2ERnlEctXPioP.jpg",425001],["I Don't Feel at Home in This World Anymore",2017,3.5,1,"Macon Blair","Thriller, Drama, Crime, Comedy","1stdUlXBc3nxqhdWvZ6wWWEbCQW.jpg",425591],["Ghostbusters: Afterlife",2021,2,1,"Jason Reitman","Fantasy, Comedy, Adventure","sg4xJaufDiQl7caFEskBtQXfD4x.jpg",425909],["Nosferatu (2024)",2024,4,1,"Robert Eggers","Horror, Fantasy","5qGIxdEO841C0tdY8vOdLoRVrr0.jpg",426063],["Beach Rats",2017,3,1,"Eliza Hittman","Drama, Romance","oQZPPsvoipd38jasPhvJOpajbug.jpg",426238],["Roma (2018)",2018,5,2,"Alfonso Cuarón","Drama","dtIIyQyALk57ko5bjac7hi01YQ.jpg",426426],["A Ghost Story",2017,4.5,1,"David Lowery","Drama, Fantasy, Romance","rp5JPIyZi9sMob15l46zNQLe5cO.jpg",428449],["Loveless",2017,4,1,"Andrey Zvyagintsev","Drama","oBUsLGZoGuLKMuHj19mjG9iCDoq.jpg",429174],["A Fantastic Woman",2017,4,1,"Sebastián Lelio","Drama","x2yNruMR8bAJOIQ3wd7HR9qWjW3.jpg",429191],["Vice",2018,2,1,"Adam McKay","Drama, Comedy","1gCab6rNv1r6V64cwsU4oEr649Y.jpg",429197],["The Other Side of Hope",2017,3.5,1,"Aki Kaurismäki","Comedy, Drama","spqAX6L4YtPaCj2dnc10Tku9AU7.jpg",429199],["Good Time",2017,4,1,"Josh Safdie & Benny Safdie","Crime, Thriller, Drama","yE1c9hj5Hf8a9KplAdRdhADqUro.jpg",429200],["Vox Lux",2018,3,1,"Brady Corbet","Drama, Music","xmFOjB5bGvFqNzsX5TbIWzdvpGd.jpg",429202],["Adrift",2018,2,1,"Baltasar Kormákur","Thriller, Romance, Adventure","5gLDeADaETvwQlQow5szlyuhLbj.jpg",429300],["Spider-Man: Far From Home",2019,2.5,3,"Jon Watts","Action, Adventure, Science Fiction","4q2NNj4S5dG2RLF9CpXsej7yXl.jpg",429617],["The Grown-Ups",2016,4,1,"Maite Alberdi","Documentary","tkgEElZW8xPBnJIPlF9zkBhKmo4.jpg",429805],["Night Is Short, Walk On Girl",2017,4.5,1,"Masaaki Yuasa","Comedy, Romance, Animation, Fantasy","7kmsC5N0m9aNSN2K4TSt65aseLU.jpg",430214],["Thanks for Dancing",2016,2.5,1,"Henrik Martin Dahlsbakken","Drama, Romance","mNSZXlUKmazMis17o5zqsEyr58z.jpg",430369],["Mary and The Witch's Flower",2017,2.5,1,"Hiromasa Yonebayashi","Animation, Adventure, Family, Fantasy","lq3OJQiJ8hlCr23LAdHbeU3eqBF.jpg",430447],["Abominable",2019,2,1,"Jill Culton","Family, Animation, Adventure, Comedy, Fantasy","20djTLqppfBx5WYA67Y300S6aPD.jpg",431580],["El almohadón de plumas",2007,3,1,"Hugo Covarrubias","Animation, Drama","mu2iSYc81Xg3TALEHdNFpnsTUB4.jpg",432401],["Scavengers",2016,3,1,"Joseph Bennett","Science Fiction, Animation","xD8TeJsXCavZq2NxS5MrUJ3t4ed.jpg",433281],["Lou",2017,3,1,"Dave Mullins","Family, Fantasy, Animation, Comedy","4l9wSwvabTefMJ3TkXnh9evzmVV.jpg",433471],["Hans Zimmer: Live in Prague",2017,4,1,"Tim Van Someren","Music","hHs54DFWuXJqh1XmYZVDsiiVHS8.jpg",435011],["The Breadwinner",2017,3,1,"Nora Twomey","Animation, War, Drama","2d6qmkJz9AWqmk9wBWtd2uFX89t.jpg",435129],["Lu Over the Wall",2017,3.5,1,"Masaaki Yuasa","Animation, Adventure, Music, Fantasy, Family","3L0a3iNraKyedBcHhrYD9sy4V5W.jpg",436120],["Ball Passing Through a Soap Bubble",1904,3,1,"Lucien Georges Bull","Documentary","tHRQMmFMarTqKpun7XXF2g45pMe.jpg",436282],["On Body and Soul",2017,3,1,"Ildikó Enyedi","Drama, Romance, Fantasy","uguWEoZelSSckxgiQctlkZ6gpfU.jpg",436343],["The Suicide Squad",2021,4,2,"James Gunn","Action, Comedy, Adventure","q61qEyssk2ku3okWICKArlAdhBn.jpg",436969],["A Taxi Driver",2017,3.5,1,"Jang Hoon","Action, Drama, History","iXVaWbxmyPk4KZGZk5GGDGFieMX.jpg",437068],["The Fortress",2019,3,1,"Hwang Dong-hyuk","War, Drama, History, Action","ww0h7mVg9AdPEMjRJKAic1w3ELa.jpg",437081],["The Villainess",2017,2.5,1,"Jung Byung-gil","Action, Thriller","tJlOV2SU6qTxR540H9VtoCAOVm.jpg",437109],["mid90s",2018,3.5,1,"Jonah Hill","Drama, Comedy","9Tw0Y3DK5kGIU9X1yw3Q9gCkOlb.jpg",437586],["Minions: The Rise of Gru",2022,2.5,1,"Kyle Balda","Animation, Comedy, Science Fiction, Crime, Family","wKiOkZTN9lUUUNZLmtnwubZYONg.jpg",438148],["Dune",2021,4.5,2,"David Lynch","Science Fiction, Adventure","d5NXSklXo0qyIYkgV94XAgMIckC.jpg",438631],["Sing 2",2021,2,1,"Garth Jennings","Animation, Comedy, Family, Music","aWeKITRFbbwY8txG5uCj4rMCfSP.jpg",438695],["Dreams of Ice",1994,3,1,"Ignacio Agüero","Documentary","",438793],["Overlord",2018,2,1,"Julius Avery","Horror, War, Science Fiction","l76Rgp32z2UxjULApxGXAPpYdAP.jpg",438799],["Happy Death Day",2017,3,1,"Christopher Landon","Comedy, Horror, Mystery","cTaEIUYTt52ooq9quVbAQ7NpGwo.jpg",440021],["Cold War",2018,4,1,"Paweł Pawlikowski","Romance, Music, Drama","6rbS8oPIgUMhQgIX8oGVTtlNgLR.jpg",440298],["Wolfwalkers",2020,5,2,"Tomm Moore","Animation, Family, Adventure, Fantasy","vqGiNbdc2sDwsnivMMYzwAoSSu6.jpg",441130],["The Beach Bum",2019,3,1,"Harmony Korine","Comedy, Drama","iXMxdC7T0t3dxislnUNybcvJmAH.jpg",441384],["Team Thor: Part 2",2017,3,1,"Taika Waititi","Science Fiction, Comedy, Fantasy","2jmP71A5Un0jDNqBesDPQSN8hjJ.jpg",441829],["Don't Worry, He Won't Get Far on Foot",2018,3,1,"Gus Van Sant","Comedy, Drama","rKsiN37qMt8jad5GikZzSeevyI9.jpg",443009],["Reservoir Dogs (1991)",1991,2.5,1,"Quentin Tarantino","Crime, Drama","oiPx0edR4IoT97KOHDJx4n1dk5U.jpg",443129],["Jerrod Carmichael: 8",2017,3,1,"Bo Burnham","Comedy","8FQ9vcZyLe29Ja2LRYQhf5gHD3w.jpg",443411],["The Bookshop",2017,2.5,1,"Isabel Coixet","Drama","nh2ZpwuTKjY0tTGcsGu7TwOpT4p.jpg",444539],["Game Night",2018,3.5,1,"Jonathan Goldstein & John Francis Daley","Mystery, Comedy, Crime","85R8LMyn9f2Lev2YPBF8Nughrkv.jpg",445571],["Fighting with My Family",2019,3,1,"Stephen Merchant","Comedy","fU4UrY5tTAYAXIzFs7oR9BK5Cqx.jpg",445629],["Bad Times at the El Royale",2018,3.5,1,"Drew Goddard","Thriller, Mystery, Crime, Drama","qExufIc4Rw0e4xdVZlhMdmEDGES.jpg",446021],["Bacurau",2019,4,1,"Kleber Mendonça Filho","Mystery, Western, Thriller","tBa4zMGzZUco26XT3WfZZCwQ76i.jpg",446159],["The Post",2017,2,1,"Steven Spielberg","Drama, History","h4XG3g6uMMPIBPjAoQhC2QIMdkl.jpg",446354],["X2",2003,3.5,1,"","Documentary","fbKrtVCaTBBdgwvrLiyYFsCewlK.jpg",447133],["A Quiet Place",2018,4,1,"John Krasinski","Horror, Drama, Science Fiction","nAU74GmpUk7t5iklEp3bufwDq4n.jpg",447332],["Guardians of the Galaxy Vol. 3",2023,3,1,"James Gunn","Science Fiction, Adventure, Action","r2J02Z2OpNTctfOSN1Ydgii51I3.jpg",447365],["X-Men",2000,3,1,"Thomas C. Grane","Documentary","vF02RqXLgtmpJM5CRLSuvN3fVHi.jpg",447399],["Pokémon Detective Pikachu",2019,2.5,1,"Rob Letterman","Action, Adventure, Fantasy","uhWvnFgg3BNlcUz0Re1HfQqIcCD.jpg",447404],["Extrapolate",2016,3.5,1,"Johan Rijpma","Animation","rGEFRbWvEOldH2fQZhNdxJy0NsQ.jpg",447885],["The Lost Brother",2017,3,1,"Adrián Caetano","Thriller, Drama, Crime","ueJ0hARGGEA2JT1o3e9DEpjErat.jpg",447904],["L.I.P.S.",2016,2,1,"Mike Cheslik","Adventure, Animation, Comedy, Fantasy, Science Fiction","sd7TWZ1oExeXE3ACt2YrtKTqEcE.jpg",447990],["Dolittle",2020,0.5,1,"Stephen Gaghan","Family, Comedy, Fantasy, Adventure","3Nt3v1uzUgfSuVARD1AnI9g9Zl9.jpg",448119],["Love, Simon",2018,3,1,"Greg Berlanti","Comedy, Drama, Romance","snIsqVPmlu4LPjvToHpDotxa7Eh.jpg",449176],["Vivo",2021,1.5,1,"Kirk DeMicco","Animation, Family, Comedy, Music","eRLlrhbdYE7XN6VtcZKy6o2BsOw.jpg",449406],["Dante's Lunch",2017,2.5,1,"Lee Unkrich","Animation, Comedy, Family","303lFHSSHSpJdINBeEesG9LPgpI.jpg",449621],["Glass",2019,1.5,1,"M. Night Shyamalan","Thriller, Drama, Science Fiction","svIDTNUoajS8dLEo7EosxvyAsgJ.jpg",450465],["Beautiful Boy",2018,3,1,"Felix van Groeningen","Drama","u2Gfv0mz3xePsgyCPHovrnFL1sB.jpg",451915],["Faces Places",2017,4,1,"Agnès Varda","Documentary","1NX6NTj9FiiJwEgRUmEifSzE7Na.jpg",451995],["Twin Peaks",1989,4,1,"David Lynch","Mystery, Drama, Thriller","Apg4fMfr1Wi19Ilu5HXh4nClCv9.jpg",452522],["Wolf Warrior 2",2017,1.5,1,"Wu Jing","War, Action","87aWrVqaVhXhblhO7sYHLC2y8TT.jpg",452557],["Serenity",2019,1,1,"Steven Knight","Thriller, Mystery, Drama","hgWAcic93phg4DOuQ8NrsgQWiqu.jpg",452832],["The Rider",2017,3.5,1,"Chloé Zhao","Drama, Western","cFsrA0Is5xode2INrPj1VJcQ18n.jpg",453278],["Doctor Strange in the Multiverse of Madness",2022,3.5,1,"Sam Raimi","Fantasy, Action, Adventure","ddJcSKbcp4rKZTmuyWaMhuwcfMz.jpg",453395],["Gemini Man",2019,1.5,1,"Ang Lee","Science Fiction, Action, Adventure, Thriller, Drama","uTALxjQU8e1lhmNjP9nnJ3t2pRU.jpg",453405],["The Play",2019,3,1,"Alejandro Fernández Almendras","Crime, Drama, Mystery, Thriller","kfm4S5DZCh2FwXXdsI4GdjpgXQc.jpg",454161],["Sonic the Hedgehog",2020,2,1,"Jeff Fowler","Action, Science Fiction, Comedy, Family","aQvJ5WPzZgYVDrxLX4R6cLJCEaQ.jpg",454626],["Crazy Rich Asians",2018,2.5,1,"Jon M. Chu","Comedy, Romance","1XxL4LJ5WHdrcYcihEZUCgNCpAW.jpg",455207],["In a Heartbeat",2017,2.5,1,"Beth David","Animation, Comedy, Romance","wJUJROdLOtOzMixkjkx1aaZGSLl.jpg",455661],["Bad Genius",2017,3,1,"Nattawut Poonpiriya","Drama, Crime, Thriller, Comedy","mgyvwqn5SYKhfg5kofZDfgH8R0q.jpg",455714],["Domino",2019,1,1,"Brian De Palma","Crime, Thriller","4ExrDZRhhmZkveXMjUzywc6266q.jpg",455957],["Tag (2018)",2018,2.5,1,"Jeff Tomsic","Comedy, Action","eXXpuW2xaq5Aen9N5prFlARVIvr.jpg",455980],["Norm Macdonald: Hitler's Dog, Gossip & Trickery",2017,3,1,"Liz Plonka","Comedy","vRmKJiLQ6oGCpJyDqtxv8LSgCW0.jpg",456193],["Epistolar",2012,4,1,"Raúl Ruiz","","sVyfzZmkmUIlH48fojxCYOdp8sb.jpg",456202],["Spider Thieves",2017,2.5,1,"Guillermo Helo J-O","Drama","gUzaHaG5SBRgmNkxoXO4NtZ0rmJ.jpg",456970],["Mary Queen of Scots",2018,2.5,1,"Josie Rourke","Drama, History","b5RMzLAyq5QW6GtN9sIeAEMLlBI.jpg",457136],["Extremely Wicked, Shockingly Evil and Vile",2019,3,1,"Joe Berlinger","Drama, Crime","a7dVwEBU3vupg3hZQMeyL6ksz0F.jpg",457799],["John Wick: Chapter 3 – Parabellum",2019,3,1,"Chad Stahelski","Action, Thriller, Crime","ziEuG1essDuWuC5lpWUaw1uXY2O.jpg",458156],["Searching",2018,3,1,"Aneesh Chaganty","Drama, TV Movie","mRZIiG4vJiCgJh4v2EPUVVTznC8.jpg",458293],["Hasan Minhaj: Homecoming King",2017,3,1,"Christopher Storer","Comedy","clFR57vfc0BXGYFIo3LYryopyY.jpg",458310],["Private Life",2018,4,1,"Tamara Jenkins","Drama, Comedy","ljym9jQlw1HypwZxlfsjuWcjQV8.jpg",458342],["Mamma Mia! Here We Go Again",2018,1.5,1,"Ol Parker","Comedy, Romance","aWicerX4Y7n7tUwRAVHsVcBBpj2.jpg",458423],["Peppermint",2018,1.5,1,"Pierre Morel","Action, Thriller","jrzxS0vcbzIIay1sdYm0rgI2QfJ.jpg",458594],["Us",2019,3,1,"Jordan Peele","Horror, Mystery","ux2dU1jQ2ACIMShzB3yP93Udpzc.jpg",458723],["First Reformed",2017,4.5,1,"Paul Schrader","Drama","8HKA3Hwf8jQWy8TCYWr7C8Wft23.jpg",458737],["Cuddle Buddy",2017,2.5,1,"Max Barbakow","Drama","t3DJMFUvZsvR3XA0Xl3YWr7gqF7.jpg",458804],["Long Shot",2019,2.5,1,"Jonathan Levine","Comedy, Romance","1F9AItQ6fhrfhBVQlmC8ReOQAFG.jpg",459992],["Mortal Kombat",2021,2.5,1,"Simon McQuoid","Action, Fantasy, Adventure","nkayOAUBUu4mMvyNf9iHSUiPjF1.jpg",460465],["Tribute to Zgougou the Cat",2002,3.5,1,"Agnès Varda","Documentary","hkNRpUPwATGLapryuwdk5hAD5Qk.jpg",460631],["Mandy",2018,3,1,"Panos Cosmatos","Fantasy, Action, Horror","wUATmL18BBQPtTqA5RCQg6emKnf.jpg",460885],["Rakka",2017,2.5,1,"Neill Blomkamp","Action, Science Fiction, Horror, War","4wVeP9BHsQul7CRgdrfiUt1Rds1.jpg",461955],["David Gilmour - Live at Pompeii",2017,3.5,1,"Gavin Elder","Music","kiWxiYLxjlBObH3lrBaPgXUTCbJ.jpg",462360],["Kuleshov Effect",1919,3,1,"Lev Kuleshov","Drama","6j2956SqTvddGIsL9ZHBS3TCnkQ.jpg",462602],["Her: The Untitled Rick Howard Project",2014,3,1,"Lance Bangs","Documentary","7pnRcfeNRQ5hpjoYRdAdJNQ1TEv.jpg",463149],["Velvet Buzzsaw",2019,1.5,1,"Dan Gilroy","Thriller, Mystery, Horror","3rViQPcrWthMNecp5XnkKev6BzW.jpg",463684],["Wonder Woman 1984",2020,1.5,1,"Patty Jenkins","Action, Adventure, Fantasy","8UlWHLMpgZm9bx6QYh0NFoq67TZ.jpg",464052],["The Week Of",2018,1,1,"Robert Smigel","Comedy","60FYEhsnY1gHsqhMbfsC1uOP8cT.jpg",465109],["If Beale Street Could Talk",2018,4,1,"Barry Jenkins","Romance, Drama","76NfwnaZI43gOQove0LU9O23Qjz.jpg",465914],["Once Upon a Time... in Hollywood",2019,4.5,3,"Quentin Tarantino","Comedy, Drama, Thriller","8j58iEBw9pOXFD2L0nt0ZXeHviB.jpg",466272],["To All the Boys I've Loved Before",2018,2.5,1,"Susan Johnson","Comedy, Romance","hKHZhUbIyUAjcSrqJThFGYIR6kI.jpg",466282],["After the Rain",1999,3.5,1,"Ross Kettle","Drama, Romance","qgV2hwqwTDAlVriIJJYfTKDJ7fE.jpg",466313],["Killers of the Flower Moon",2023,4.5,1,"Martin Scorsese","Crime, History, Drama","dB6Krk806zeqd0YNp2ngQ9zXteH.jpg",466420],["Spielberg",2017,3,1,"Susan Lacy","Documentary","2AAvIR2PHoxNITgLDOkXXlWLlua.jpg",467062],["The Zone of Interest",2023,4.5,1,"Jonathan Glazer","Drama, History, War","hUu9zyZmDd8VZegKi1iK1Vk0RYS.jpg",467244],["The Wandering Soap Opera",2017,4,2,"Raúl Ruiz","Fantasy, Comedy, Drama","hsVZr1hdkfnxIxJNjeOQGC97VF3.jpg",467254],["Unsane",2018,3,1,"Steven Soderbergh","Horror, Thriller","wdaUssQhZDOgegkJZx7NfY75HRX.jpg",467660],["The Runaway Match, or Marriage by Motor",1903,3.5,1,"Alf Collins","Drama, Action, Romance","5WgM0Bju3YIK0GrU8AbRaDbckmV.jpg",467891],["In the Heights",2021,2.5,1,"Jon M. Chu","Drama, Romance","RO4KoJyoQMQzh9z76d4v4FJMmJ.jpg",467909],["Revenge",2017,3.5,1,"Coralie Fargeat","Action, Horror, Thriller, Drama","AbWKFxt459cWYTNPTcbpB0i2hQp.jpg",467938],["Jim & Andy: The Great Beyond",2017,3.5,1,"Chris Smith","Documentary, Drama, Comedy","kKzopOFXz9YfsCTqg3XpF0GoypX.jpg",469019],["Cat City",2017,3,1,"Victoria Vincent","Animation, Comedy, Drama","yQuPN9RGQrKjoR7Hf76knU2MMIM.jpg",469154],["Damn Kids",2017,2,1,"Gonzalo Justiniano","Drama","8nNq59A6wCDkkAJ6JwQ0E5QLUjK.jpg",469341],["Great Choice",2017,3,1,"Robin Comisar","Horror, Comedy, Drama","s3zyvyGH68JQ7pUwYBVS3RYwhKC.jpg",469918],["World of Tomorrow Episode Two: The Burden of Other People's Thoughts",2017,4,1,"Don Hertzfeldt","Science Fiction, Animation, Drama, Comedy","8nSucrEs2xZU1bXxhtMfh4imYOE.jpg",471495],["Coffee and Cigarettes III",1993,3,1,"Jim Jarmusch","Comedy","1qbgQfFIG1YA5TzwdbZsWymHDbh.jpg",472693],["Invader Zim: Enter the Florpus",2019,3,1,"Jhonen Vasquez","Animation, Comedy, Science Fiction","lYy5EBxl8cwpyejcy85LgSdf34m.jpg",472983],["Uncut Gems",2019,4,1,"Josh Safdie & Benny Safdie","Drama, Thriller, Crime","6XN1vxHc7kUSqNWtaQKN45J5x2v.jpg",473033],["2036: Nexus Dawn",2017,2,1,"Luke Scott","Science Fiction, Thriller","qPci3811kFmPPEevGrnjeKWokD4.jpg",473072],["Princesita",2017,2,1,"Marialy Rivas","Drama","pLYcVQ9PrJByX7eR2WedIV7NJtB.jpg",473319],["La Escala",1964,2.5,1,"Aldo Francia","Fantasy, Drama","aDqJx5YYiGMUpvehAA9uJ1FFaeQ.jpg",473777],["It Chapter Two",2019,1.5,1,"Andy Muschietti","Horror, Thriller, Drama","zfE0R94v1E8cuKAerbskfD3VfUt.jpg",474350],["Teen Titans Go! To the Movies",2018,2.5,1,"Aaron Horvath","Animation, Action, Comedy, Science Fiction","mFHihhE9hlvJEk2f1AqdLRaYHd6.jpg",474395],["Mirai",2018,3,1,"Mamoru Hosoda","Animation, Family, Fantasy, Adventure, Drama","b9XvI4Nehzi0nXyNVD6DtT39P6l.jpg",475215],["A Rainy Day in New York",2019,2,1,"Woody Allen","Comedy, Romance","z4A6mFOLTMZAhCSPRyrtzG0SPbd.jpg",475303],["Joker",2019,3.5,2,"Todd Phillips","Crime, Thriller, Drama","udDclJoHjfjb8Ekgsd4FDteOkCU.jpg",475557],["2048: Nowhere to Run",2017,2.5,1,"Luke Scott","Science Fiction, Thriller, Action, Drama","l8JKbUCIe4y1LujxMMjbxG6ueH.jpg",475759],["Blade Runner: Black Out 2022",2017,4,1,"Shinichiro Watanabe","Animation, Science Fiction, Thriller","zzRjnUOVXyjp2WudgT7KxJLYh9D.jpg",475946],["Bergman Island",2021,3.5,1,"Mia Hansen-Løve","Drama, Romance","q8bQfC7SbaTDVKywhCiNL3ZVSyy.jpg",477044],["Men in Black: International",2019,1.5,1,"F. Gary Gray","Comedy, Science Fiction, Action, Adventure","dPrUPFcgLfNbmDL8V69vcrTyEfb.jpg",479455],["Stealing Rodin",2017,3.5,1,"Cristóbal Valenzuela","Documentary","cJ8Bpnk3QSflMS2UMYNwLw1X4HM.jpg",479581],["Creed II",2018,3,1,"Steven Caple Jr.","Drama, Action","v3QyboWRoA4O9RbcsqH8tJMe8EB.jpg",480530],["Laps",2017,3,1,"Charlotte Wells","Drama","nKlV4T5BjLYwI7ZBbVOTbzZXtxK.jpg",480702],["Radioactive",2019,1.5,1,"Marjane Satrapi","Drama, Romance, History","akHIQu8W3rOgT28r25ggXaKcQIr.jpg",480857],["Penguin Island",2017,3,1,"Guille Söhrens","Drama","2jD3wSVJJxk1dOKNn6ZWyM5NNZE.jpg",480930],["Happy as Lazzaro",2018,4.5,1,"Alice Rohrwacher","Drama, Fantasy","j4x1O6G0cbchHQwNsEZ0DntOJMJ.jpg",481432],["Eugenia",2017,2,1,"Martín Boulocq","Drama","bWFFonGS2rCVpqQvCS0PvoYfq3a.jpg",481595],["Liz and the Blue Bird",2018,4,1,"Naoko Yamada","Animation, Drama, Music","7xRIkqWJy4cNpUxPo5aZ24O0Tyx.jpg",482150],["Here's the Plan",2017,3.5,1,"Fernanda Frick","Drama, Animation","58Ba1L0eqoORtV2Dafb3bO5NQTG.jpg",482866],["Wild Rose",2018,3.5,1,"Tom Harper","Music, Comedy, Drama","79THplH9WM7y3gRPYM4dcC0IRPw.jpg",482981],["Dear Basketball",2017,2,1,"Glen Keane","Animation, History","b3NGzWIhzgquYP263ZfAQNsi11Z.jpg",483306],["Coming 2 America",2021,1,1,"Craig Brewer","Comedy","nWBPLkqNApY5pgrJFMiI9joSI30.jpg",484718],["Este mar sabe demasiado, Takilleitor",1998,0.5,2,"Daniel de la Vega","Comedy, Science Fiction","887TXo4fTnE8tOsY48oygi1Z7Ez.jpg",486752],["BlacKkKlansman",2018,3.5,1,"Spike Lee","Crime, Comedy, Drama, History","8jxqAvSDoneSKRczaK8v9X5gqBp.jpg",487558],["Sweet Things",2017,3,1,"Henry K. Norvalls","Drama","zuuRq3xD1nSng52uzDrioALICWE.jpg",487921],["It's Such a Beautiful Day",2012,5,1,"Don Hertzfeldt","Animation, Comedy","hop0dsM4nxyNENGhBhpJWTCJ5rS.jpg",489412],["Eighth Grade",2018,4,1,"Bo Burnham","Comedy, Drama","xTa9cLhGHfQ7084UvoPQ2bBXKqd.jpg",489925],["Blindspotting",2018,4,1,"Carlos López Estrada","Comedy, Crime, Drama","x4DRZfTqOlmzNWAvy4vcKWkgEGL.jpg",489930],["Three Identical Strangers",2018,3.5,1,"Tim Wardle","Documentary","esPoJNMBsgWXahv8gILIl5K6sFk.jpg",489988],["Shirkers",2018,3,1,"Sandi Tan","Documentary","spd1fZNePSQFRhNam66jx3ZMoxF.jpg",489994],["Won't You Be My Neighbor?",2018,4,1,"Morgan Neville","Documentary","8qE8NZjiP2M884baH0VoLF828Vp.jpg",490003],["Green Book",2018,2,1,"Peter Farrelly & Bobby Farrelly","Drama, Comedy, History","7BsvSuDQuoqhWmU2fL7W2GOcZHU.jpg",490132],["Judy",2019,2.5,1,"Rupert Goold","Drama, History, Music","iqJhHjD6k6T07waELjMKDpQJUP.jpg",491283],["Burning",2018,4,1,"Lee Chang-dong","Mystery, Drama, Thriller","kXiF80o74fE9gf3Utf9moAI7ar0.jpg",491584],["Marriage Story",2019,5,2,"Noah Baumbach","Drama","2JRyCKaRKyJAVpsIHeLvPw5nHmw.jpg",492188],["RBG",2018,2.5,1,"Betsy West","Documentary","vIenhDe9DuvxODJOIpMjBheYlcS.jpg",493099],["Dungeons & Dragons: Honor Among Thieves",2023,3.5,1,"Jonathan Goldstein & John Francis Daley","Adventure, Fantasy, Comedy","v7UF7ypAqjsFZFdjksjQ7IUpXdn.jpg",493529],["Hereditary",2018,4,1,"Ari Aster","Horror, Mystery, Thriller","lHV8HHlhwNup2VbpiACtlKzaGIQ.jpg",493922],["Birds of Prey (and the Fantabulous Emancipation of One Harley Quinn)",2020,2,1,"Cathy Yan","Action, Crime","h4VB6m0RwcicVEZvzftYZyKXs6K.jpg",495764],["Parasite",2019,5,5,"Bong Joon Ho","Comedy, Thriller, Drama","7IiTTgloJzvGI1TAYymCfbfl3vT.jpg",496243],["Atlantics",2019,2.5,1,"Mati Diop","Drama, Romance, Fantasy","zRnZM6HqglFK31MYyrTSQVlj1dQ.jpg",496967],["A Pot of Boiling Oil",2017,3.5,1,"Jason S.","Documentary","bLR8p5UlTENOFDzwa8k3098RF8h.jpg",497468],["Derecho viejo",1998,3,1,"Mariano Llinás","Drama","",497540],["Enola Holmes",2020,2,1,"Harry Bradbeer","Adventure, Mystery, Crime","riYInlsq2kf1AWoGm80JQW5dLKp.jpg",497582],["Black Widow",2021,2.5,1,"Cate Shortland","Action, Adventure, Science Fiction","qAZ0pzat24kLdO3o8ejmbLxyOac.jpg",497698],["Triangle of Sadness",2022,3.5,1,"Ruben Östlund","Comedy, Drama","k9eLozCgCed5FGTSdHu0bBElAV8.jpg",497828],["Twin Peaks: The Return",2017,4,1,"David Lynch","Documentary","tfpAwd3v3hxA1Bmz7G8K8AdZApb.jpg",498842],["The Wolf House",2018,4.5,1,"Cristóbal León & Joaquín Cociña","Animation, Horror, Drama","kvgch2e25cd6dWhRJ6G8BCJ1Wcq.jpg",499537],["Blue Christmas",2017,3,1,"Charlotte Wells","Drama","71DcqziAqseWFIOm72Gs8mw0ZWc.jpg",500477],["Upgrade",2018,3,1,"Leigh Whannell","Action, Thriller, Science Fiction","woLGROUdPWdBnLVFKYdGD3kFkPY.jpg",500664],["Marilyn",2018,2.5,1,"Martín Rodríguez Redondo","Drama","3hQOCWJcQgrlrPYueP0nwG09zPr.jpg",500831],["I'm Thinking of Ending Things",2020,4.5,2,"Charlie Kaufman","Mystery, Thriller, Drama","5ynWWapdl45hJXUh0KIevxSG9JQ.jpg",500840],["Doctor Sleep",2019,3,1,"Mike Flanagan","Horror, Fantasy","p69QzIBbN06aTYqRRiCOY1emNBh.jpg",501170],["A Beautiful Day in the Neighborhood",2019,2,1,"Marielle Heller","History, Family, Drama","pgxn1siPnWbSOKUeovfC86OwhWU.jpg",501907],["The Mitchells vs. the Machines",2021,4,2,"Mike Rianda","Animation, Adventure, Comedy","mI2Di7HmskQQ34kz0iau6J1vr70.jpg",501929],["Bill & Ted Face the Music",2020,2.5,1,"Dean Parisot","Comedy, Science Fiction, Adventure, Music","4V2nTPfeB59TcqJcUfQ9ziTi7VN.jpg",501979],["Munchausen",2013,4,1,"Ari Aster","Drama, Comedy, Horror","560dinuPqIGkjETqS8hp9KeI6c3.jpg",502025],["Sound of Metal",2019,4,1,"Darius Marder","Drama, Music","3178oOJKKPDeQ2legWQvMPpllv.jpg",502033],["Sapo",2018,1.5,1,"Juan Pablo Ternicier","Drama, Crime, Thriller","eYilGjbaa9dkcLgKeghwE3bmbev.jpg",502071],["I can Friday by day!",2015,2.5,1,"Kazuya Tsurumaki","Comedy, Science Fiction, Animation","fsPtanmQ4kjvJIMJZWF4pAT1VqY.jpg",502165],["Martin Scorsese Directs",1990,2.5,1,"Steven Fischler","Documentary","mwKxKT4BqiSqzLebB9UTzJqO27B.jpg",502332],["The Super Mario Bros. Movie",2023,2.5,1,"Aaron Horvath","Family, Comedy, Adventure, Fantasy, Animation","qNBAXBIQlnOThrVvA6mA2B5ggV6.jpg",502356],["The Lighthouse",2019,4,2,"Robert Eggers","Drama, Fantasy, Thriller","f1tIYarTbkBdIT1aW0gzelDwknv.jpg",503919],["Shiva Baby (2018)",2018,2.5,1,"Emma Seligman","Comedy, Drama","t0Pi1QqL3p6xrXLfOK3cFbfqK4Q.jpg",504512],["Rocketman",2019,3.5,1,"Dexter Fletcher","Music, Drama","f4FF18ia7yTvHf2izNrHqBmgH8U.jpg",504608],["Death on the Nile (2022)",2022,2.5,1,"Kenneth Branagh","Mystery, Crime, Thriller","kVr5zIAFSPRQ57Y1zE7KzmhzdMQ.jpg",505026],["Chris Rock: Tamborine",2018,2,1,"Bo Burnham","Comedy","AdL5Vu9GcBlyC9T9bowojEOFs8X.jpg",505159],["Floor 9.5",2017,2.5,1,"Toby Meakins","Horror","8zUayaiUp1DVKR25EV0Q7Pu0Qk4.jpg",505188],["Shoplifters",2018,4.5,1,"Hirokazu Kore-eda","Drama, Crime, Thriller","4nfRUOv3LX5zLn98WS1WqVBk9E9.jpg",505192],["Booksmart",2019,3,1,"Olivia Wilde","Comedy","2aSxRDmisJP90H3S0aocyuQIe4z.jpg",505600],["Black Panther: Wakanda Forever",2022,2.5,1,"Ryan Coogler","Action, Adventure, Science Fiction","sv1xJUazXeYqALzczSZ3O6nkH75.jpg",505642],["Team Darryl",2018,2,1,"Taika Waititi","Comedy, Fantasy, Science Fiction","edroTAeTEM9ILyAnumA0ALxRSne.jpg",505945],["Nae Pasaran",2018,3,1,"Felipe Bustos Sierra","Documentary","xkPX2E5HUkbGsMSPOvmsQ3xkcW0.jpg",506612],["Climax",2018,4.5,1,"Gaspar Noé","Drama, Horror, Music","47IXH2iEWwX0F7vIyGXaKQ0psBG.jpg",507076],["Jurassic World Dominion",2022,1.5,1,"Colin Trevorrow","Adventure, Science Fiction, Thriller, Action","jbAvCACjLf1ZG0unB2tdmx5HAf1.jpg",507086],["El Angel",2018,4,1,"Luis Ortega","Drama, Crime","hKtxOC2Mx9v4vx5TNJprzrFiy7.jpg",507505],["Onward",2020,2.5,1,"Dan Scanlon","Adventure, Animation, Comedy, Family, Fantasy","f4aul3FyD3jv3v4bul1IrkWZvzq.jpg",508439],["Soul",2020,4,1,"Pete Docter","Animation, Family, Drama, Music, Fantasy","6jmppcaubzLF8wkXM36ganVISCo.jpg",508442],["Sad Hill Unearthed",2017,3,1,"Guillermo de Oliveira","Documentary, History","1DgoWzjWlLzN4GuLgrIe2iScTPt.jpg",508466],["The One and Only Ivan",2020,2,1,"Thea Sharrock","Family, Comedy, Drama","wDOyGAiTaXvjKGmnmXsoFO7zItt.jpg",508570],["The Boy and the Heron",2023,4,1,"Hayao Miyazaki","Animation, Fantasy, Drama","f4oZTcfGrVTXKTWg157AwikXqmP.jpg",508883],["Ricky Gervais: Humanity",2018,3,1,"John L. Spencer","Comedy","vXNvvb9RUXSZS08PvXxLtA9wrfV.jpg",508933],["Luca",2021,3.5,1,"Enrico Casarosa","Animation, Family, Fantasy, Drama, Comedy","9x4i9uKGXt8IiiIF5Ey0DIoY738.jpg",508943],["Turning Red",2022,3,1,"Domee Shi","Animation, Family, Comedy, Fantasy","qsdjk9oAKSQMWs0Vt5Pyfh6O4GZ.jpg",508947],["Klaus",2019,2.5,1,"Sergio Pablos","Animation, Family, Comedy","q125RHUDgR4gjwh1QkfYuJLYkL.jpg",508965],["The Fanatic",2019,1,1,"Fred Durst","Crime, Thriller","nojx83s8JWyYpI9oeKdQXniWMu6.jpg",509853],["Dry Martina",2018,3,1,"Che Sandoval","Comedy, Drama","gA6nTGlDtFdRtGEYHSEBzSJ1Xzy.jpg",510338],["Bergman's Reliquarium",2018,2.5,1,"Tomas Alfredson","Drama","cgtT0e9YhDBLT5RBvRe2km2oH0J.jpg",510406],["High Flying Bird",2019,2,1,"Steven Soderbergh","Drama","ccE21xixa1zhkGtWDr4n8ReOp40.jpg",510498],["West Side Story (2022)",2021,4,1,"Steven Spielberg","Drama, Romance, Crime","yfz3IUoYYSY32tkb97HlUBGFsnh.jpg",511809],["Wendell & Wild",2022,2,1,"Henry Selick","Animation, Comedy, Fantasy, Adventure, Horror","5dsX6UAHqkQz1kiV8bs8SvjyVNa.jpg",511817],["Memoria",2021,4,1,"Apichatpong Weerasethakul","Drama, Science Fiction, Mystery","uZ4GABzjCIiQNlYSgjXoaf6rpK5.jpg",511819],["Happy Death Day 2U",2019,3.5,1,"Christopher Landon","Comedy, Horror, Science Fiction","4tdnePOkOOzwuGPEOAHp8UA4vqx.jpg",512196],["Jumanji: The Next Level",2019,2,1,"Jake Kasdan","Adventure, Comedy, Fantasy","jyw8VKYEiM1UDzPB7NsisUgBeJ8.jpg",512200],["Honey Boy",2019,3,1,"Alma Har'el","Drama","3BZ2rBn31kWER45ZMj7OTe9keMm.jpg",512263],["...And Suddenly the Dawn",2017,4,1,"Silvio Caiozzi","Drama","vk8XzNnKexYobxYQCXvQwx1GN2k.jpg",513264],["One Cut of the Dead",2017,4.5,2,"Shinichiro Ueda","Comedy, Horror, Drama","rws34k2bqYVo2B5MkhKAbV8925j.jpg",513434],["Always Be My Maybe",2019,2.5,1,"Nahnatchka Khan","Romance, Comedy","3BO6pPa7qDcpPYct061Luh9fvst.jpg",513576],["A Twelve-Year Night",2018,3,1,"Álvaro Brechner","Drama, Crime, History","k1SEABHjk34flsBQigm9ygMuUM4.jpg",514575],["Bao",2018,4,1,"Domee Shi","Animation, Family, Fantasy, Drama, Comedy","tKz7XRXvdy1i7pW4eotaWZSrAx2.jpg",514754],["The Hunt (2020)",2020,2.5,1,"Craig Zobel","Action, Thriller, Horror","wxPhn4ef1EAo5njxwBkAEVrlJJG.jpg",514847],["Il Siciliano",2017,3,1,"José Luis Sepúlveda & Carolina Adriazola","Documentary","oKwRpatfxF9ivTqtrLk1GvhcRGy.jpg",514861],["Jojo Rabbit",2019,4,2,"Taika Waititi","Comedy, War, Drama","7GsM4mtM0worCtIVeiQt28HieeN.jpg",515001],["Free Solo",2018,3.5,1,"Jimmy Chin","Documentary, Adventure","v4QfYZMACODlWul9doN9RxE99ag.jpg",515042],["Yesterday",2019,1.5,1,"Danny Boyle","Comedy, Fantasy, Music, Romance","9fYka5CQt9nrb6LOtKicysUf9NA.jpg",515195],["Girl",2018,3,1,"Lukas Dhont","Drama","ts996lKsxvjkO2yiYG0ht4qAicO.jpg",515916],["Too Late to Die Young",2018,3.5,1,"Dominga Sotomayor","Drama","ezypWqGmkhtRt9I9LpLUwzZNfC3.jpg",515929],["Greyhound",2020,3,1,"Aaron Schneider","War, Action, Drama","kjMbDciooTbJPofVXgAoFjfX8Of.jpg",516486],["Five Easy Pieces (1995)",1995,2,1,"Steve McQueen","","vDHrXLMuDGE1J79vjJHYVycirTY.jpg",516686],["Being the Ricardos",2021,2,1,"Aaron Sorkin","Drama, History","oztBLWdRk5gApYmNdADXvXkLT5m.jpg",517088],["Capernaum",2018,1.5,1,"Nadine Labaki","Drama","mFnfTVADj8yOxwzprYOmTPselk8.jpg",517814],["The Laundromat",2019,1.5,1,"Steven Soderbergh","Crime, Drama, Comedy","hwNMJgbiUUvPCxsnADjbV9ysM5j.jpg",517909],["Diamantino",2018,3,1,"Daniel Schmidt","Comedy, Science Fiction, Fantasy","yzsPJrEOE0f9giXewV1OBkFyDUk.jpg",518495],["Pain and Glory",2019,4,1,"Pedro Almodóvar","Drama","cMlueArJXXwZbeLpb4NhC3pxmBk.jpg",519010],["Kyoko",2017,2.5,1,"Joan Bover","Documentary","rNPEANNjX6otrHkuS40dFfeOotE.jpg",519097],["Matthias & Maxime",2019,2.5,1,"Xavier Dolan","Drama, Romance","j3DI3UjYBRqIbO1keUU1Bzn5qG6.jpg",519141],["Despicable Me 4",2024,1.5,1,"Pierre Coffin & Chris Renaud","Animation, Comedy, Action, Science Fiction, Family","wWba3TaojhK7NdycRhoQpsG0FaH.jpg",519182],["Bodies Bodies Bodies",2022,2.5,1,"Halina Reijn","Comedy, Mystery, Horror","hSuTjDmqRdy7Dii8ymnF2WILTeP.jpg",520023],["Happiest Season",2020,3,1,"Clea DuVall","Romance, Comedy","vzec9kkOSE93tygyfOktedkeOQ.jpg",520172],["Chicken Run: Dawn of the Nugget",2023,2,1,"Sam Fell","Family, Animation, Adventure, Comedy","eImY0cjbH0bll8EXSqxqEZIZcmY.jpg",520758],["A Quiet Place Part II",2020,2.5,1,"John Krasinski","Science Fiction, Thriller, Horror","4q2hz2m8hubgvijz8Ez0T2Os2Yv.jpg",520763],["Laika",2017,1.5,1,"Aurel Klimt","Animation, Comedy, Science Fiction","6jjtgjezIc8Wbfsjg5kOaXs4uqt.jpg",521690],["Cam",2018,2.5,1,"Daniel Goldhaber","Horror, Mystery","p7m3sSQhnoT2uuxUsxF4mQX6opr.jpg",521935],["The Last Black Man in San Francisco",2019,3,1,"Joe Talbot","Drama","ow9zjibNrz5TYVZ6cqwmvCR1YX1.jpg",522039],["Sorry We Missed You",2019,4,1,"Ken Loach","Drama","jNvlqNDnXH8aqBeiBxNNP0wWWO3.jpg",522369],["The Gentlemen",2019,2.5,1,"Guy Ritchie","Action, Comedy, Crime","jtrhTYB7xSrJxR1vusu99nvnZ1g.jpg",522627],["Escape Room",2019,2,1,"Adam Robitel","Horror, Mystery, Thriller","8Ls1tZ6qjGzfGHjBB7ihOnf7f0b.jpg",522681],["Maestro",2023,2,1,"Bradley Cooper","Drama, Romance, Music","kxj7rMco6RNYsVcNwuGAIlfWu64.jpg",523607],["Summerland",2020,2.5,1,"Jessica Swale","Drama, Romance","owfKp0rbBa8vHoNO30MdB3GiaYU.jpg",523977],["Period. End of Sentence.",2018,3,1,"Rayka Zehtabchi","Documentary","dsCeBj8oabzsHQOGGLPrmrqIvDs.jpg",524288],["The Report",2019,2,1,"Scott Z. Burns","Drama","sG5NI6TMNR9ftOdTIXmG0hrBYSY.jpg",524348],["The Many Saints of Newark",2021,2,1,"Alan Taylor","Crime, Drama","1UkbPQspPbq1FPbFP4VV1ELCfSN.jpg",524369],["Eternals",2021,2,1,"Chloé Zhao","Science Fiction, Action, Adventure","lFByFSLV5WDJEv3KabbdAF959F2.jpg",524434],["7:20 Once a Week",2018,1.5,1,"Matías Bize","Romance, Drama","5dRTrNj5h2Kiq9tWh2CMrpuCB00.jpg",525107],["Cowboy Bebop: Don't Bother None",2012,2,1,"Shinichiro Watanabe","Action, Crime, Western","oio8N3TauBTEPkuef3hnXUKbrZN.jpg",525191],["Bombshell",2019,1.5,1,"Jay Roach","Drama","gbPfvwBqbiHpQkYZQvVwB6MVauV.jpg",525661],["Morbius",2022,1,1,"Daniel Espinosa","Action, Science Fiction, Fantasy","Av8Z2jZhEm1FLkFzMThzz9hndJF.jpg",526896],["God",2019,3,1,"Christopher Murray","Drama, Comedy","69SYznq2mSbgKyQF3QHYwblmqAk.jpg",527660],["Raya and the Last Dragon",2021,2.5,1,"Carlos López Estrada","Animation, Action, Adventure, Fantasy, Family","5nVhgCzxKbK47OLIKxCR1syulOn.jpg",527774],["WHAT DID JACK DO?",2017,3.5,1,"David Lynch","Comedy, Mystery, Crime","68FofMgclH1qCNXoL6foBqPfNFD.jpg",528491],["Dolemite Is My Name",2019,3,1,"Craig Brewer","Drama, Comedy, History","uoAqJg7ZSmftnBGOkupU1ySZQU0.jpg",528888],["The Croods: A New Age",2020,2,1,"Joel Crawford","Animation, Family, Adventure, Fantasy, Comedy","tbVZ3Sq88dZaCANlUcewQuHQOaE.jpg",529203],["Ride Your Wave",2019,4,1,"Masaaki Yuasa","Animation, Romance, Comedy, Drama, Fantasy","byoY2stdullEcVjlaWs1ENXyrDm.jpg",530079],["Midsommar",2019,4.5,2,"Ari Aster","Horror, Drama, Mystery","7LEI8ulZzO5gy9Ww2NVCrKmHeDZ.jpg",530385],["The Legend of the Stardust Brothers",1985,4.5,4,"Makoto Tezuka","Music, Comedy","fkT12vml7dNS53OmjNnuzqX9jYm.jpg",530578],["Education",2020,3.5,1,"Steve McQueen","Drama, Crime, History","gizz5FphOtfSnLaGpRALOZgILd5.jpg",530723],["1917",2019,2.5,1,"Sam Mendes","War, Drama, History","iZf0KyrE25z1sage4SYFLCCrMi9.jpg",530915],["Portrait of a Lady on Fire",2019,5,3,"Céline Sciamma","Drama, Romance","2LquGwEhbg3soxSCs9VNyh5VJd9.jpg",531428],["Eurovision Song Contest: The Story of Fire Saga",2020,1.5,1,"David Dobkin","Music, Comedy","9zrbgYyFvwH8sy5mv9eT25xsAzL.jpg",531454],["Pinocchio (2022)",2022,1,1,"Robert Zemeckis","Fantasy, Adventure, Family","zaZhjKrJeWczQ3AotKoQObppEbH.jpg",532639],["Waves",2019,3,1,"Trey Edward Shults","Romance, Drama","3xbjL0z8iH8e8L3USyeKGQrBfuZ.jpg",533444],["Deadpool & Wolverine",2024,1.5,1,"Shawn Levy","Action, Comedy, Science Fiction","8cdWjvZQUExUUTzyp4t6EDMubfO.jpg",533535],["La Pampa Gringa",1963,2.5,1,"Fernando Birri","Documentary","lo1ILNmGVBtiV3SdMEzLVEUqvNo.jpg",535314],["Elisa & Marcela",2019,2.5,1,"Isabel Coixet","Drama, Romance","zOd1CB3TgV1RLtnCHtDSPeC9tId.jpg",535356],["The Dead Don't Die",2019,2,1,"Jim Jarmusch","Comedy, Drama, Horror, Crime, Fantasy","fgGzTEoNxptCRtEOpOPvIEdlxAq.jpg",535581],["HAIM / Valentine",2017,3.5,1,"Paul Thomas Anderson","Music","pTQq8eczXH8tfGwS0eadzZnIaAe.jpg",536213],["Diego Maradona",2019,4,1,"Asif Kapadia","Documentary","3eBZxi0xcXBnEYq4m4YTVf0eHWX.jpg",536841],["Cats",2019,1,1,"Tom Hooper","Fantasy, Comedy, Drama","aCNch5FmzT2WaUcY44925owIZXY.jpg",536869],["Steven Universe: The Movie",2019,2.5,1,"Rebecca Sugar","TV Movie, Animation, Family, Adventure, Fantasy","8mRgpubxHqnqvENK4Bei30xMDvy.jpg",537061],["tick, tick... BOOM!",2021,3.5,2,"Lin-Manuel Miranda","Drama, Music","DPmfcuR8fh8ROYXgdjrAjSGA0o.jpg",537116],["The Ballad of Buster Scruggs",2018,3.5,1,"Joel Coen & Ethan Coen","Western, Comedy, Drama","voxl654m7p36y8FLu8oQD7dfwwK.jpg",537996],["They'll Love Me When I'm Dead",2018,3,1,"Morgan Neville","Documentary","h7YHg3BOEjlZSCJ41FBHyeQkoUG.jpg",538002],["It Must Be Heaven",2019,3,1,"Elia Suleiman","Comedy, Drama","ljor2pWczSOQFBGAMevqZ7s8D4W.jpg",539531],["Leading Lady Parts",2018,2,1,"Jessica Swale","Comedy","uqaPliWfQbPROdnQIX4qOZ6V8tf.jpg",539572],["Ema",2019,4,1,"Pablo Larraín","Drama","9p78EwUeo7NkFFCIBzU8jwxC867.jpg",540709],["Hustlers",2019,3.5,1,"Lorene Scafaria","Drama, Comedy, Crime","zBhv8rsLOfpFW2M5b6wW78Uoojs.jpg",540901],["Passing",2021,2.5,1,"Rebecca Hall","Drama","t4tYUT1oSWOP6XKZBoclPAG96KP.jpg",541524],["Ballerina",2025,2.5,1,"Len Wiseman","Action, Thriller, Crime","2VUmvqsHb6cEtdfscEA6fqqVzLg.jpg",541671],["The French Dispatch of the Liberty, Kansas Evening Sun",2021,4.5,1,"Wes Anderson","Drama, Comedy","6JXR3KJH5roiBCjWFt09xfgxHZc.jpg",542178],["Do You Like to Read?",2012,3,1,"Wes Anderson","Comedy, Animation","cmNdWBmMXfSIAIH9acAUrjKB57e.jpg",542609],["Guava Island",2019,2.5,1,"Hiro Murai","Comedy, Thriller, Music","oQ5OnvNNGUYOPh3iTjmqx6GPsdc.jpg",543343],["Long Way Back Home",2018,2.5,1,"Jeff Nichols","","",543477],["They Shall Not Grow Old",2018,4,1,"Peter Jackson","Documentary, History, War","yMGfJeTXUdIjOqjS0jJfjgYEuYC.jpg",543580],["Everything Everywhere All at Once",2022,5,4,"Daniel Kwan & Daniel Scheinert","Action, Adventure, Science Fiction","u68AjlvlutfEIcpmbYpKcdi09ut.jpg",545611],["Knives Out",2019,4.5,2,"Rian Johnson","Comedy, Crime, Mystery","pThyQovXQrw2m0s9x82twj48Jq4.jpg",546554],["Greener Grass",2019,4,1,"Dawn Luebbe & Jocelyn DeBoer","Comedy","eN56wiM2M84GBOQnp4TAQXcZucg.jpg",547009],["The Old Guard",2020,2,1,"Gina Prince-Bythewood","Action, Fantasy","cjr4NWURcVN3gW5FlHeabgBHLrY.jpg",547016],["Being Good",2017,1,1,"Jenny Harder","Animation","yDJMOTHZmi9nMd0qlTcmbvK6e5j.jpg",547369],["Last Christmas",2019,2,1,"Paul Feig","Comedy, Drama, Romance","kDEjffiKgjuGo2DRzsqfjvW0CQh.jpg",549053],["One Small Step",2018,3,1,"Andrew Chesworth","Family, Animation, Adventure, Fantasy","4O13uunA2LmNvHpr7PjTCDUmSZ1.jpg",549484],["The Brutalist",2024,5,1,"Brady Corbet","Drama","vP7Yd6couiAaw9jgMd5cjMRj3hQ.jpg",549509],["Flight of the Conchords: Live in London",2018,4,5,"Hamish Hamilton","Comedy, Music","m3lJEwPM8i2oFjwNaGyc0PFrzUz.jpg",550416],["Free Guy",2021,1.5,1,"Shawn Levy","Comedy, Adventure, Science Fiction","dxraF0qPr1OEgJk17ltQTO84kQF.jpg",550988],["The Hairdressers",2007,3,1,"Maite Alberdi","Documentary","sat0G1L33CTNN2WvF1mCFTGMxNm.jpg",551218],["The Two Popes",2019,3,1,"Fernando Meirelles","Drama, History","4d4mTSfDIFIbUbMLUfaKodvxYXA.jpg",551332],["Freaky",2020,3.5,1,"Christopher Landon","Horror, Comedy","8xC6QSyxrpm0D5A6iyHNemEWBVe.jpg",551804],["Dark Waters",2019,3,1,"Todd Haynes","Drama, Thriller","bzvzaHqKBSuGIIWhinTQPHvT0zf.jpg",552178],["Lina from Lima",2019,3,1,"María Paz González","Comedy, Drama","uwkiDD8aZ0Rt7YaKoJ8CqMaMCMz.jpg",552365],["The Lost Daughter",2021,3.5,1,"Maggie Gyllenhaal","Drama","t1oLNRFixpFOVsyz1HCqCUW3wiW.jpg",554230],["This Is Cristina",2019,2.5,1,"Gonzalo Maza","Drama, Comedy","6crVEMZ3TFvg6FEa4DIj5oTymzk.jpg",554914],["Varda by Agnès",2019,3.5,1,"Agnès Varda","Documentary","99xU63PePSbtffV5CUqPQYu84XY.jpg",554967],["Are You There God? It's Me, Margaret.",2023,3,1,"Kelly Fremon Craig","Comedy, Drama","yb6UB4WC3znlwU0L4AqMnjR9G9S.jpg",555285],["Guillermo del Toro's Pinocchio",2022,3.5,1,"Guillermo del Toro","Animation, Fantasy, Adventure, Drama","vx1u0uwxdlhV2MUzj4VlcMB0N6m.jpg",555604],["Hamilton",2020,3,2,"Thomas Kail","History, Drama","h1B7tW0t399VDjAcWJh8m87469b.jpg",556574],["Emma.",2020,3,2,"Autumn de Wilde","Comedy, Romance, Drama","uHpHzbHLSsVmAuuGuQSpyVDZmDc.jpg",556678],["The Trial of the Chicago 7",2020,3,1,"Aaron Sorkin","Drama, History","ahf5cVdooMAlDRiJOZQNuLqa1Is.jpg",556984],["Gladiator II",2024,2.5,1,"Ridley Scott","Action, Adventure, Drama","2cxhvwyEwRlysAmRH4iodkvo0z5.jpg",558449],["First Cow",2019,4,1,"Kelly Reichardt","Drama, Western","yS41crZ1i0fFxCQbuL7I1Y1VBwm.jpg",558582],["The Color Purple",2023,2.5,1,"Blitz Bazawule","Drama","h5bqIxM8GO4TewJ0u6Rzkg58ssJ.jpg",558915],["Sibyl",2019,3.5,1,"Justine Triet","Drama","9W4pznUF8Np6qHExgclaRHVHzom.jpg",559401],["The Green Knight",2021,3,1,"David Lowery","Adventure, Drama, Fantasy","if4hw3Ou5Sav9Em7WWHj66mnywp.jpg",559907],["El Camino: A Breaking Bad Movie",2019,3,1,"Vince Gilligan","Crime, Drama, Thriller","ePXuKdXZuJx8hHMNr2yM4jY2L7Z.jpg",559969],["Over the Moon",2020,1.5,1,"Glen Keane","Animation, Adventure, Family, Fantasy","lG0TF0wj1n9p9CPy5xlIUIkF56a.jpg",560050],["The Sea Beast",2022,2,1,"Chris Williams","Animation, Adventure, Action, Family, Fantasy","9Zfv4Ap1e8eKOYnZPtYaWhLkk0d.jpg",560057],["Los Reyes",2018,4,1,"Bettina Perut & Iván Osnovikoff","Documentary","rRgHmxW0dPwcYVFXxui7F0TzHSm.jpg",560153],["Zurita, You Will See Not to See",2018,3,1,"Alejandra Carmona","Documentary","axPnXVYp8u2YWZ5F4qE5yUKUfB8.jpg",560753],["Maniac",2018,3.5,1,"Cary Joji Fukunaga","Horror, Animation, Mystery","gtR67n4vZx7xy07fcFnjF8oZLRA.jpg",561679],["Make Us Dream",2018,3.5,1,"Sam Blair","Documentary","ikuKQxE1tfVMCIZVsMyePaZlNEy.jpg",561894],["The Farewell",2019,4,1,"Lulu Wang","Comedy, Drama","7ht2IMGynDSVQGvAXhAb83DLET8.jpg",565310],["The Death of Dick Long",2019,3,1,"Daniel Kwan & Daniel Scheinert","Comedy, Crime, Drama","vURitOcmtcH8Dr1bWryTvfkeyJX.jpg",565383],["To All the Boys: P.S. I Still Love You",2020,1.5,1,"Michael Fimognari","Romance, Comedy","maib5VlmEqp5xlN8lptnBSftp2o.jpg",565426],["American Factory",2019,3,1,"Julia Reichert","Documentary","7jH3dQOJ3CHMrp9tWsI3rRCDiaD.jpg",565716],["The United States vs. Billie Holiday",2021,1.5,1,"Lee Daniels","Music, Drama, History","vEzkxuE2sJcmHYjXQHM8xvR9ICH.jpg",566076],["One Child Nation",2019,3.5,1,"Nanfu Wang","Documentary","bV0aqhB7fsw5mWJROBnFro1Qhwn.jpg",566368],["Ozu: Passageways",2012,3.5,1,"Kogonada","","6DF6FZo3q091TzcfQ6CHdi5vzAt.jpg",566437],["Shang-Chi and the Legend of the Ten Rings",2021,3.5,1,"Destin Daniel Cretton","Action, Adventure, Fantasy","d08HqqeBQSwN8i8MEvpsZ8Cb438.jpg",566525],["Clown",2010,2.5,1,"Jon Watts","Horror","",567083],["La noche mágica de Gaspar",2018,2,1,"Gabriel Osorio","Animation, Family","2O04AuTgYQNaLDPlR95ESesaQIS.jpg",567223],["Ready or Not",2019,3,1,"Tyler Gillett & Matt Bettinelli-Olpin","Horror, Comedy","oJD9KQFoObZmxAS1je56SIFVNJt.jpg",567609],["Fyre",2019,3,1,"Chris Smith","Documentary","yFsP0BAJhAH3RTXCAnGvI1CtaUb.jpg",567860],["Encanto",2021,3,1,"Byron Howard","Animation, Comedy, Family, Fantasy","4j0PNHkMr5ax3IA8tjtxcmPU3QT.jpg",568124],["Spider-Man: Across the Spider-Verse",2023,4.5,1,"Joaquim Dos Santos","Animation, Action, Adventure, Science Fiction","8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg",569094],["Black Mirror: Bandersnatch",2018,2.5,1,"David Slade","Thriller, Science Fiction, Mystery","fR0VZ0VE598zl1lrYf7IfBqEwQ2.jpg",569547],["The Invisible Man (2020)",2020,4,1,"Leigh Whannell","Thriller, Science Fiction, Horror","5EufsDwXdY2CVttYOk2WtYhgKpa.jpg",570670],["Numéro 1765",2009,3,1,"Cyrus Neshvad","","kDxV7vEKPA7JH5eqsLxxq9kc6tH.jpg",572547],["Help! (1992)",1992,3,1,"Edgar Wright","Thriller, Comedy","9H3fRFKzC5fUztx2ibJVnfpX36T.jpg",573752],["Forced Hilarity",2001,2.5,1,"Edgar Wright","Comedy","p785wMohqHHK5VVvT6T7yzsSkv7.jpg",573764],["Kitbull",2019,3,1,"Rosana Sullivan","Animation, Family, Drama","mwKO3cZbxipgd9QAPboJVTDLPiN.jpg",574074],["The Weasel's Tale",2019,2.5,1,"Juan José Campanella","Comedy, Mystery","wcAHJpXWOOLukNW7nSe5snBt0xK.jpg",574088],["Float",2019,2.5,1,"Bobby Rubio","Animation, Drama, Family, Fantasy","mgwObpU1NCXfPqF7ZaTpi80mxsF.jpg",574093],["Final Destination Bloodlines",2025,3.5,1,"Zach Lipovsky","Horror, Mystery","6WxhEvFsauuACfv8HyoVX6mZKFj.jpg",574475],["Rolling Thunder Revue: A Bob Dylan Story by Martin Scorsese",2019,3,1,"Martin Scorsese","Documentary, Music","ixxELBgYj9OH8hz0XCrcZOJpIx9.jpg",574638],["Mission: Impossible – Dead Reckoning",2023,3.5,1,"Christopher McQuarrie","Action, Adventure, Thriller","NNxYkU70HPurnNCSiCjYAmacwm.jpg",575264],["Mission: Impossible – The Final Reckoning",2025,3,1,"Christopher McQuarrie","Action, Thriller, Adventure","z53D72EAOxGRqdr7KXXWp9dJiDe.jpg",575265],["On the Rocks",2020,2.5,1,"Sofia Coppola","Drama, Comedy, Romance","fcijRCmB7yTtloh4Pumy9b1rkwU.jpg",575417],["Saint Maud",2019,4,1,"Rose Glass","Horror, Mystery, Thriller","ArNYeeDFLVye7JpqLElYdbE6fOa.jpg",575776],["For Sama",2019,4,1,"Waad al-Kateab","Documentary, War","mDna51F8QfrJFZOgPGQUz3VKqsB.jpg",576017],["Last Night in Soho",2021,3.5,1,"Edgar Wright","Horror, Mystery, Drama, Thriller","n1ZRmjlk1BJTY7aASqACfPAaLn2.jpg",576845],["Lemebel",2019,3.5,1,"Joanna Reposi","Documentary","dqXbYgaXOtZxIRNE6dS9Nynvw2r.jpg",577080],["Khartoum Offside",2019,2.5,1,"Marwa Zein","Documentary","9MmL9H2y0XEK7jCxWozCXCNsvpi.jpg",577081],["Hi-Fi",2000,2,1,"Sean Baker","Music, Romance, Drama","4GrcJ23118Yt4zRMMRa2IsH2xC2.jpg",577569],["Tenet",2020,2,1,"Christopher Nolan","Action, Thriller, Science Fiction","aCIFMriQh8rvhxpN1IWGgvH0Tlg.jpg",577922],["Bad Trip",2021,2,1,"Kitao Sakurai","Comedy","A1Gy5HX3DKGaNW1Ay30NTIVJqJ6.jpg",578908],["RRR",2022,4,1,"S. S. Rajamouli","Action, History, Drama","u0XUBNQWlOvrh0Gd97ARGpIkL0.jpg",579974],["Another Round",2020,4,1,"Thomas Vinterberg","Comedy, Drama","aDcIt4NHURLKnAEu7gow51Yd00Q.jpg",580175],["Venom: Let There Be Carnage",2021,1.5,1,"Andy Serkis","Science Fiction, Action, Adventure","pzKsRuKLFmYrW5Q0q8E8G78Tcgo.jpg",580489],["News of the World",2020,2.5,1,"Paul Greengrass","Drama, Western, Adventure","fYQCgVRsQTEfUrP7cW5iAFVYOlh.jpg",581032],["Nomadland",2020,3.5,1,"Chloé Zhao","Drama","dKT8rGDR55cM1vGn7QZLA9Tg9YC.jpg",581734],["Da 5 Bloods",2020,3,1,"Spike Lee","War, Drama","yx4cp1ljJMDSFeEex0Zjv45b55E.jpg",581859],["Promising Young Woman",2020,4,1,"Emerald Fennell","Thriller, Crime, Drama","73QoFJFmUrJfDG2EynFjNc5gJxk.jpg",582014],["The Cordillera of Dreams",2019,3.5,1,"Patricio Guzmán","Documentary","3hDV1rtZyRWzhMKmscSW5une7jh.jpg",582944],["Judas and the Black Messiah",2021,3,1,"Shaka King","Drama, History","iIgr75GoqFxe1X5Wz9siOODGe9u.jpg",583406],["Moxie",2021,2,1,"Amy Poehler","Comedy, Drama, Music","aLBo1Ca9PggcWY98ItW5ZkdxTuA.jpg",583689],["Between Two Ferns: The Movie",2019,2,1,"Scott Aukerman","Comedy","cHxc8v1GkzdjjhF2qnpG6wdXrOT.jpg",584962],["Perro bomba",2019,3,1,"Juan Cáceres","Drama","2Du3VfvKSvVEgzSin6Dd4TxosQD.jpg",585172],["After Yang",2021,3,1,"Kogonada","Science Fiction, Drama","qjEuDeKOhA7JqaaqhLSfoS9titb.jpg",585378],["Daddy",2019,2,1,"Christian Coppola","Comedy, Horror, Mystery, Thriller","uAfeUHiaINCMi2DGNiGbpKGX7C2.jpg",586592],["Mi amigo Alexis",2019,1.5,1,"Alejandro Fernández Almendras","Family, Comedy, Drama","iSo0NoWvTtZf9S9PrfUo3kWI0Xa.jpg",586599],["I Lost My Body",2019,3,1,"Jérémy Clapin","Animation, Drama, Fantasy","z5dXCywyo8zEPNDkeQY7nbvkrz8.jpg",586940],["Palm Springs",2020,4,1,"Max Barbakow","Comedy, Romance, Science Fiction","gnAfqiV7yO3Jq9IntTmwkcaICqc.jpg",587792],["Hair Love",2019,2.5,1,"Matthew A. Cherry","Animation, Family, Comedy","pm9uRa7031Z56unxNE8AqE8f2wg.jpg",589739],["Love and Monsters",2020,2.5,1,"Michael Matthews","Adventure, Comedy, Fantasy","718NnyxyQuBQcGWt9sdelA1Zc3h.jpg",590223],["Fear Street: 1994",2021,2.5,1,"Leigh Janiak","Horror, Mystery, Drama","9J9Wy39ZjrVmfk7yMkulpcI5sy0.jpg",591273],["Fear Street: 1978",2021,3.5,1,"Leigh Janiak","Horror, Mystery","5dNTxhoGDTHHGqUTdxcr4H1dqlU.jpg",591274],["Fear Street: 1666",2021,3,1,"Leigh Janiak","Mystery, Horror","rmEPtz3Ufzol2VWUAZYzOFaBio3.jpg",591275],["The Tragedy of Macbeth",2021,3,1,"Joel Coen & Ethan Coen","Drama","tDNJEhcLbX3jIk3BMCur9pCdaVD.jpg",591538],["Bad Hair",2013,2.5,1,"Mariana Rondón","Comedy","",592422],["Megalopolis",2024,2.5,1,"Francis Ford Coppola","Science Fiction, Drama, Fantasy","8Sok3HNA3r1GHnK2lCytHyBz1A.jpg",592831],["Hillbilly Elegy",2020,2.5,1,"Ron Howard","Drama","aA0D6DKIfLtXYNy94Qq2IW5NiGR.jpg",592984],["Guanabacoa: Chronicle of My Family",1966,2.5,1,"Sara Gómez","Documentary","b6wyAH1rMhlkwlyxzNqbCd13NeL.jpg",593186],["My Contribution",1972,3.5,1,"Sara Gómez","Documentary","gTdG9DGifGF0cbiZfK7XZ9NEN1P.jpg",593516],["The Menu",2022,3.5,1,"Mark Mylod","Comedy, Horror","fPtUgMcLIboqlTlPrq0bQpKK8eq.jpg",593643],["Shazam! Fury of the Gods",2023,2,1,"David F. Sandberg","Comedy, Action, Fantasy","3GrRgt6CiLIUXUtoktcv1g2iwT5.jpg",594767],["Causeway",2022,2.5,1,"Lila Neugebauer","Drama","bUzKIqFIS05Ss31zRTfZfHJIgDP.jpg",595586],["Never Rarely Sometimes Always",2020,4,1,"Eliza Hittman","Drama","7yiSyQhhjTFphhfCUcn05tCQxyG.jpg",595671],["Other Side of the Box",2018,3.5,1,"Caleb J. Phillips","Horror, Thriller","urrCNl6jz5h1xIm0JZk0Dn5SEUJ.jpg",595801],["Family Romance, LLC",2019,3,1,"Werner Herzog","Drama","igtALo7638WulIIdBSQetdjFGWN.jpg",595900],["Heroic Losers",2019,2.5,1,"Sebastián Borensztein","Comedy, Thriller","9MaAzW8sERDcIEYORE7jzeCew3P.jpg",596054],["Pacto de Fuga",2020,2.5,1,"David Albala","Drama, Thriller","qDFfu73R8uO94ydFtdxEdSfTlg6.jpg",596247],["Nightmare Alley (2021)",2021,3.5,1,"Guillermo del Toro","Crime, Drama, Thriller","vfn1feL0V9HNSXuLLpaxAW8O6LO.jpg",597208],["The Half of It",2020,3.5,1,"Alice Wu","Comedy, Romance, Drama","jC1PNXGET1ZZQyrJvdFhPfXdPP1.jpg",597219],["Lux Æterna",2019,3.5,1,"Gaspar Noé","Drama, Thriller","5oStzv8gUrAAevtIiv0icGcvAbq.jpg",599377],["The Father",2020,4.5,1,"Florian Zeller","Drama","pr3bEQ517uMb5loLvjFQi8uLAsp.jpg",600354],["The Power of the Dog",2021,3,1,"Jane Campion","Drama, Western","kEy48iCzGnp0ao1cZbNeWR6yIhC.jpg",600583],["The Windshield Wiper",2021,2.5,1,"Alberto Mielgo","Animation, Romance","hkfe9DfheH7zRu8Yj2wXqukbrTx.jpg",601329],["The Eyes of Tammy Faye",2021,2.5,1,"Michael Showalter","Drama, History","h09nsvxZH72zx2U8gS8vrg47aRk.jpg",601470],["Spiral: From the Book of Saw",2021,2.5,1,"Darren Lynn Bousman","Horror, Mystery","cTvSDfBuXTZTdRCNduGMANd7VEP.jpg",602734],["The Tango of the Widower and Its Distorting Mirror",2020,1.5,1,"Raúl Ruiz","Drama, Fantasy, Horror","yzbqP9woGq2wGUJh0DzVXlr3Th7.jpg",602986],["John Wick: Chapter 4",2023,4.5,1,"Chad Stahelski","Action, Thriller, Crime","vZloFAK7NmvMGKE7VkF5UHaz0I.jpg",603692],["Dead End.",2019,4,1,"Victoria Vincent","Drama","oBzy5QHV0i4xdINOYVVQURwjBno.jpg",606968],["The Final Exit of the Disciples of Ascensia",2019,3.5,1,"Jonni Peppers","Comedy, Animation, Science Fiction, Drama","9Vc6AJvUBkghgYbzEYtyrtfEJ61.jpg",607033],["Clinton Road",2019,0.5,1,"Richard Grieco","Horror","gruCOT1exw6iu6RjPVt2riVUWFn.jpg",607776],["Chernobyl",2019,4.5,1,"Johan Renck","Drama","1lAxvdtv8lAlDgUnMikkh6bmZ8b.jpg",608558],["Anima",2019,3.5,2,"Paul Thomas Anderson","Music","xCBOjFAzsz8d2kABIPfwIAOeJ5t.jpg",610120],["Halloween Kills",2021,1.5,1,"David Gordon Green","Horror, Thriller","ir9eyz1mtgsohjvo7UYtqUfFuES.jpg",610253],["The Prom",2020,1.5,1,"Ryan Murphy","Romance, Comedy","9oHvqd1QL5kaqt6zmCuDmM8esjV.jpg",611213],["My Favorite Shapes by Julio Torres",2019,2,1,"Dave McCary","Comedy, TV Movie","v1Bx5clsiLnAmHPOqRIMOnFmKrY.jpg",612392],["Frankenstein's Monster's Monster, Frankenstein",2019,2,1,"Daniel Gray Longino","Comedy","aVrXQAk0lIRw123EghPfNlludjU.jpg",612701],["Aziz Ansari: Right Now",2019,3,1,"Spike Jonze","Comedy, TV Movie, Documentary","5vaYOkQ3MxOnxQLeKUNXiAfZVHb.jpg",613999],["To All the Boys: Always and Forever",2021,3,1,"Michael Fimognari","Romance, Comedy, Drama","iepqdM52f4w75fNcvgRF5QoIAjm.jpg",614409],["Mank",2020,3.5,1,"David Fincher","Drama, History","4yzTcAtvzyZLLto4z04xobUK9el.jpg",614560],["Lupin III: The First",2019,3,1,"Takashi Yamazaki","Adventure, Animation, Comedy, Crime, Mystery","lK0BCJWib1TFeFmQFNEJBMZfEPz.jpg",614587],["The Midnight Sky",2020,1.5,1,"George Clooney","Science Fiction, Drama","l8lXesOLXKS0VYjzWNZN6gDxv2F.jpg",614911],["King Richard",2021,3,1,"Reinaldo Marcus Green","Drama, History","2dfujXrxePtYJPiPHj1HkAFQvpu.jpg",614917],["Teenage Mutant Ninja Turtles: Mutant Mayhem",2023,3.5,1,"Jeff Rowe","Animation, Comedy, Action, Science Fiction","gyh0eECE2IqrW8GWl3KoHBfc45j.jpg",614930],["Elvis",2022,2.5,1,"Baz Luhrmann","Music, History, Drama","qBOKWqAFbveZ4ryjJJwbie6tXkQ.jpg",614934],["Nobody",2021,3.5,1,"Ilya Naishuller","Action, Thriller","oBgWY00bEFeZ9N25wWVyuQddbAo.jpg",615457],["Minari",2020,4,2,"Lee Isaac Chung","Drama","tV4DsRCDVl0Xr41o1dGnWgbZ9GL.jpg",615643],["Ma Rainey's Black Bottom",2020,3,1,"George C. Wolfe","Drama, Music","pvtyxijaBrCSbByXLcUIDDSvc40.jpg",615667],["Babylon",2022,4.5,1,"Damien Chazelle","Drama, Comedy","wjOHjWCUE0YzDiEzKv8AfqHj3ir.jpg",615777],["Hecho bolsa",2019,1,2,"Felipe Izquierdo","Comedy","d1KvaAhRUqUQ06swK91HFeZn0Ms.jpg",615846],["Thor: Love and Thunder",2022,2,1,"Taika Waititi","Fantasy, Action, Comedy","pIkRyD18kl4FhoCNQuWxWu5cBLM.jpg",616037],["I Never Climbed the Provincia",2019,4,1,"Ignacio Agüero","Documentary","5rMAGhWoM59u3xqX7HlCawK7CK5.jpg",616113],["Halloween Ends",2022,2,1,"David Gordon Green","Horror, Thriller","q06saepaXeBdkMibuN4R2fXmgIw.jpg",616820],["The Last Duel",2021,4,1,"Ridley Scott","Drama, History, Thriller","zjrJE0fpzPvX8saJXj8VNfcjBoU.jpg",617653],["Photo Op",2015,1.5,1,"Dave Solomon","Drama, Mystery, Thriller","dNf3bBhDaBAaLUOIe5CMZzlu6aa.jpg",618072],["Collective",2019,3,1,"Alexander Nanau","Documentary","oR93n0CAn2GznyHDFSRTp0J1t8c.jpg",618363],["Electric Swan",2019,4,1,"Konstantina Kotzamani","Drama","2VbVUJABVdhLpfNJZlOifOZEsoV.jpg",618367],["Don't Worry Darling",2022,2.5,1,"Olivia Wilde","Mystery, Thriller, Science Fiction, Horror","jOqxKIOC92BVyinYO1Fm73XY7Tc.jpg",619730],["Malignant",2021,3.5,1,"James Wan","Horror, Mystery","dGv2BWjzwAz6LB8a8JeRIZL8hSz.jpg",619778],["Little Nemo: Adventures in Slumberland Pilot 2",1984,3.5,1,"Andrew Gaskill","Animation, Fantasy, Adventure","AgBy8KelzBjmLvSGFDxKg200bHm.jpg",621240],["The Moneychanger",2019,4,1,"Federico Veiroj","Comedy, Drama","7fPN6QWkvE7NByS5vqkdFUelIAU.jpg",621268],["Crazy World",2014,4,1,"Nabwana IGG","Action, Comedy","qiFmLdWJwvIA1tlwerUWBkG2du3.jpg",621706],["Nimic",2019,2.5,1,"Yorgos Lanthimos","Drama, Fantasy, Mystery, Thriller","gRzUDFYke2DCVxmddotNatQ5FDl.jpg",621749],["Pearl (2016)",2016,3.5,1,"Patrick Osborne","Animation","wVDPRvLfiY3mJztp6nPwMd6jjMp.jpg",623098],["False Indigo",2020,1.5,1,"Christopher Hooton","Drama, Horror","zHsN0oY63PZYZH2MWoDDOWJUxUS.jpg",623226],["White Man",1994,2,1,"Bong Joon Ho","Drama","eIRGWKW8UMhTf7Yb53fnqvnOyxA.jpg",623631],["Let Them All Talk",2020,2.5,1,"Steven Soderbergh","Comedy, Drama","4mhZqZ7nXL6Dj6PKZSseJxv1qXZ.jpg",623856],["Harley Queen",2019,4,1,"José Luis Sepúlveda & Carolina Adriazola","Documentary","9VvKPamQ8dEyrJ6O92MVKTqVS1k.jpg",623931],["The Matrix Resurrections",2021,1.5,1,"Lilly & Lana Wachowski","Science Fiction, Action, Adventure","8c4a8kE7PizaGQQnditMmI1xbRp.jpg",624860],["Flamin' Hot",2023,2,1,"Eva Longoria","Drama, History","a7KyFMPXj0iY4EoLq1PIGU1WJPw.jpg",626332],["Lunana: A Yak in the Classroom",2019,2,1,"Pawo Choyning Dorji","Drama","mL1OQc1cxGsOIVHgjDvyvmPSmad.jpg",627087],["Tour Eiffel",2006,2.5,1,"Sylvain Chomet","Drama","cgcjTias4Ps4GkTyXk9w9tF7qu3.jpg",627184],["The White Tiger",2021,3,1,"Ramin Bahrani","Drama","5JnmseS3DZ6ad2VMbrnbGCs8Rst.jpg",628534],["American Factory: A Conversation with the Obamas",2019,2.5,1,"Yoruba Richen","Documentary","rVoVRToKaxpdkUEJFIf46rWNVHR.jpg",628756],["The Bad Guys",2022,2.5,1,"Pierre Perifel","Action, Animation, Comedy, Crime, Family","7qop80YfuO0BwJa1uXk1DXUUEwv.jpg",629542],["Titane",2021,4.5,2,"Julia Ducournau","Drama, Thriller, Horror","AeQC4gFwkIvjAwnSd2RPAlgs1VE.jpg",630240],["A Love Song for Latasha",2019,3,1,"Sophia Nahli Allison","Documentary","pZ3PHUoqfxJYyNgprIrQJs3HgWP.jpg",631344],["Knock at the Cabin",2023,2,1,"M. Night Shyamalan","Horror, Mystery, Thriller","dm06L9pxDOL9jNSK4Cb6y139rrG.jpg",631842],["Old",2021,2,1,"M. Night Shyamalan","Thriller, Mystery, Horror","vclShucpUmPhdAOmKgf3B3Z4POD.jpg",631843],["C'mon C'mon",2021,3.5,1,"Mike Mills","Drama","1oOyJsdcJnnE7cl9bZdUQvBjKNH.jpg",632617],["Don’t Forget",1982,4,1,"Ignacio Agüero","Documentary","6TNH5OAQURuvBalYGCjsgyMOJic.jpg",633662],["Madame Web",2024,1,1,"S.J. Clarkson","Action, Fantasy","rULWuutDcN5NvtiZi4FRPzRYWSh.jpg",634492],["Spider-Man: No Way Home",2021,3.5,2,"Jon Watts","Action, Adventure, Science Fiction","1g0dhYtq4irTY1GPXvft6k4YLjm.jpg",634649],["Pig",2021,3.5,1,"Michael Sarnoski","Drama, Thriller, Mystery","1InMm4Mbjx8wCKvIy5gglo5i3HN.jpg",635731],["Wrath of Man",2021,3,1,"Guy Ritchie","Thriller, Crime, Drama","M7SUK85sKjaStg4TKhlAVyGlz3.jpg",637649],["Sirena",2019,3,1,"Carlos Piñero","Drama","tV9dMfPDwbBR0AOSKR4qFRdbuc.jpg",637675],["Space Journey",2019,3.5,1,"Carlos Araya Díaz","Documentary","1XUHmnbH8Xel7sEdulsPFzERkcw.jpg",637936],["Bangers",1999,1.5,1,"Andrew Upton","Drama, Comedy","ckmuojN8lXR5q45IX0wqY6WYNx7.jpg",638942],["Stuart X",2019,3,1,"Thibault Upton","Documentary","a3olpYxLCD12CLECR2eLBdD2Tof.jpg",639155],["The Journey of Monalisa",2019,3,1,"Nicole Costa","Documentary","lBTmL9ITPulYuJ2eMvZNbeUVH3W.jpg",639311],["The Northman",2022,3.5,1,"Robert Eggers","Action, Adventure, Fantasy","aSSJMnHknzKjlZ6zybwD7eyJ4Po.jpg",639933],["No Other Choice",2025,4.5,2,"Park Chan-wook","Comedy, Crime, Thriller","vc2S0dvgpsM0XfSiXZDMVkRCSSU.jpg",639988],["Ant-Man and the Wasp: Quantumania",2023,1,1,"Peyton Reed","Action, Adventure, Science Fiction","qnqGbB22YJ7dSs4o6M7exTpNxPz.jpg",640146],["Once Upon a Time… All About My Mother",2012,3,1,"Antoine de Gaudemar","Documentary, TV Movie","htsTo21enUXNi0cL2EDQlDMb08u.jpg",640160],["Pieces of a Woman",2020,4,1,"Kornél Mundruczó","Drama","OgUfLlhfBFx5BPK6LzBWFvBW1w.jpg",641662],["Four Good Days",2020,2.5,1,"Rodrigo García","Drama","uaJmqZxwAsdFLLjPGH5DzIEnbpj.jpg",641960],["Inu-Oh",2021,4,1,"Masaaki Yuasa","Animation, Drama, Music, Fantasy, History","ysetY1G2ys6s5Lk4mOsuChDQXSG.jpg",642538],["Thanksgiving",2007,2.5,1,"Eli Roth","","hzK60YiGXAbO0zOwcOL044nkOEC.jpg",642629],["Hocus Pocus 2",2022,2,1,"Anne Fletcher","Fantasy, Comedy","7ze7YNmUaX81ufctGqt0AgHxRtL.jpg",642885],["House of Gucci",2021,2,1,"Ridley Scott","Drama, Crime, History","oJCQjD2byiVF1EG408F9dBn9ndU.jpg",644495],["Don't Look Up",2021,1.5,1,"Adam McKay","Comedy, Science Fiction, Drama","th4E1yqsE8DGpAseLiUrI60Hf8V.jpg",646380],["Scream (2022)",2022,4,1,"Tyler Gillett & Matt Bettinelli-Olpin","Horror, Mystery","1m3W6cpgwuIyjtg5nSnPx7yFkXW.jpg",646385],["Special Actors",2019,2.5,1,"Shinichiro Ueda","Comedy","hRwEBYXiZkfKHhvMF5rb1JyCAwb.jpg",648564],["The Unbearable Weight of Massive Talent",2022,2,1,"Tom Gormican","Action, Comedy, Crime","aqhLeieyTpTUKPOfZ3jzo2La0Mq.jpg",648579],["Work",2010,3.5,1,"Mike Rianda","Animation, Comedy","n8WPifbckrjWKDLFWxO74q12vvI.jpg",649041],["No Sudden Move",2021,3.5,1,"Steven Soderbergh","Crime, Thriller","kARdPEc4b32GQlHmJXMhGOCplEA.jpg",649409],["Renfield",2023,1.5,1,"Chris McKay","Comedy, Fantasy, Horror","jG83l0tDwoQj3hBAioIsJ5rTPHw.jpg",649609],["My Tender Matador",2020,2.5,1,"Rodrigo Sepúlveda","Drama, Romance","7mM9PVIqMJh37pocDuuJH5Q56mt.jpg",651170],["The Irishman: In Conversation",2019,2,1,"","Documentary","fF704pR8xsNjI7dVi4M4rPUqxvU.jpg",651724],["The Wolf of Snow Hollow",2020,4,1,"Jim Cummings","Horror, Thriller","nXeTSXR5ryFwxrlpmD9hhXJTAuc.jpg",652004],["Turu, the Wacky Hen",2019,0.5,1,"Víctor Monigote","Family, Animation, Music, Adventure","xaG10x1C8dCHkNumSslH6jwzvpt.jpg",653247],["Dick Johnson Is Dead",2020,4.5,1,"Kirsten Johnson","Documentary","vnfI34kmi3fcdgP7HZjIgGOJHGY.jpg",653574],["Feels Good Man",2020,4.5,1,"Arthur Jones","Documentary","osN5whpwiXN5j7umqemCKoCiXKi.jpg",653578],["Spree",2020,3.5,1,"Eugene Kotlyarenko","Comedy, Horror, Thriller","tbYvzpy4QFhUHRBHe4VeUKJst96.jpg",653598],["Disclosure",2020,3.5,1,"Sam Feder","Documentary","2MB2FPNxdSlykbH7ghBltoBYnTH.jpg",653610],["Boys State",2020,3,1,"Amanda McBaine","Documentary","cuvt3ImM3wQdijib7OeIH48uRfQ.jpg",653723],["Crip Camp: A Disability Revolution",2020,3.5,1,"Jim LeBrecht","Documentary","iALSypN3MhC6kBVwc9VpuJUlm1j.jpg",653725],["Time",2020,3.5,1,"Garrett Bradley","Documentary","2yLZmlf6vdpkhTaD0oUmIFu8SsM.jpg",653729],["The Mole Agent",2020,4.5,1,"Maite Alberdi","Documentary","eWKySzO45iIbT4yL2zVkVB2w6MR.jpg",653756],["Billie Eilish: The World's a Little Blurry",2021,3.5,1,"R. J. Cutler","Documentary, Music","bDQ95W5LPHW9FHlPj3QX3jvM9Z7.jpg",654754],["Jackass Forever",2022,3,1,"Jeff Tremaine","Action, Comedy, Documentary","ruHDFumJfW7F2vEqTZEQQ9xT7CA.jpg",656663],["The Worst Person in the World",2021,5,3,"Joachim Trier","Drama, Romance, Comedy","1NxGNQchGBTHXJ6RShLY1IlZqWn.jpg",660120],["Glass Onion",2022,3.5,1,"Rian Johnson","Comedy, Crime, Mystery","vDGr1YdrlfbU9wxTOdpf3zChmv9.jpg",661374],["A Complete Unknown",2024,3.5,1,"James Mangold","Drama, Music","llWl3GtNoXosbvYboelmoT459NM.jpg",661539],["One Night in Miami...",2020,3.5,1,"Regina King","Drama","1DLUb9PTDqXMSgsD7RmiJs7ZJIx.jpg",661914],["Yes-People",2020,1.5,1,"Gísli Darri Halldórsson","Animation, Comedy","c0Y6zYIhi9M9VB5QCNaEmg69cPR.jpg",663343],["Censor",2021,3.5,1,"Prano Bailey-Bond","Horror, Mystery","1FOEEtGFPp5cgpLfPQVMB0UNVpI.jpg",663866],["Genius Loci",2020,3.5,1,"Maya Merigeau","Animation, Drama, Fantasy","9Z5sjvSv2hGZwm9DaSjOF142gny.jpg",663881],["She Dies Tomorrow",2020,4,1,"Amy Seimetz","Drama","ogTna9bUzldTV5l2nyuyJV4tbCH.jpg",664297],["Shiva Baby",2020,4,1,"Emma Seligman","Comedy, Drama","4sdqVsT6SHqtbCYZS7bhVoEftlL.jpg",664300],["Goldman v Silverman",2020,3,1,"Josh Safdie & Benny Safdie","Drama, Comedy","leslGAKPG0HS37gt3Zr6vu8MM3v.jpg",664394],["Beastie Boys Story",2020,3.5,1,"Spike Jonze","Music, Documentary","mph9vxXnEgiFrkrUqMk40DpPtEX.jpg",664416],["Apollo 10½: A Space Age Childhood",2022,3,1,"Richard Linklater","Animation, Comedy, Drama, Science Fiction","ms3qa9LH9kosaGCSe22NJ7fDPv9.jpg",664996],["Past Lives",2023,4,1,"Celine Song","Drama, Romance","k3waqVXSnvCZWfJYNtdamTgTtTA.jpg",666277],["Straight to One",1993,3,1,"Ethan Hawke","Romance","j6KN0B0VZEN06g2WXUKBH7xsZmI.jpg",667275],["mask dog",2018,3,1,"Victoria Vincent","Animation, Crime, Comedy","6CPpeaercnX5zlohzSPJWJWKPwC.jpg",667347],["Catscape",2019,3,1,"Victoria Vincent","Animation","9mw054UuQZl2oMcNyyb6AoZRHth.jpg",667348],["The Life Ahead",2020,2,1,"Edoardo Ponti","Drama","6oTn5kXRS84exXTC7XcqotKZu9B.jpg",667869],["Roald Dahl's Matilda the Musical",2022,2.5,1,"Matthew Warchus","Family, Comedy, Fantasy","ga8R3OiOMMgSvZ4cOj8x7prUNYZ.jpg",668482],["David Byrne's American Utopia",2020,4,1,"Spike Lee","Music, Documentary","sHVeVCNhlY2asvoGsSMP5HOLbCI.jpg",668800],["Hot Dog",1983,2,1,"Anna Muylaert","Comedy","orIA1npvcPYYwOLv71nXukVlP6S.jpg",669134],["The Man Who Sold His Skin",2020,2.5,1,"Kaouther Ben Hania","Drama","o1wRIwEttuWUByTm1wXsfCstNlh.jpg",669363],["The Creator",2023,3,1,"Gareth Edwards","Science Fiction, Action, Adventure","3dSivDtOuyxLDxPH4v2tcNG1fP7.jpg",670292],["The Human Voice",2020,2.5,1,"Pedro Almodóvar","Drama","1ExeKYF7ryDKImnPg2LkDfcYizg.jpg",671577],["Guardians of Life",2020,2,1,"Shaun Monson","Drama","AjvpOoEoqqs0rcfxxWTnrdfQImG.jpg",671892],["The Map of Tiny Perfect Things",2021,4,1,"Ian Samuels","Fantasy, Romance","6y3ev0rJFbHA1hU22UPmmfzBjrG.jpg",672647],["Mean Girls (2024)",2024,1.5,1,"Arturo Perez Jr.","Comedy","2ZkuQXvVhh45uSvkBej4S7Ix1NJ.jpg",673593],["The Banshees of Inisherin",2022,4.5,1,"Martin McDonagh","Drama, Comedy","4yFG6cSPaCaPhyJ1vtGOtMD1lgh.jpg",674324],["White Eye",2019,3,1,"Tomer Shushan","Drama","9cX3xHMVgFvxZ6zRyqjgAvUKHjY.jpg",675235],["Sonic the Hedgehog 2",2022,1,1,"Jeff Fowler","Action, Adventure, Family, Comedy","6DrHO1jr3qVrViUO6s6kFiAGM7.jpg",675353],["PAW Patrol: The Movie",2021,2.5,1,"Cal Brunker","Action, Adventure, Animation, Comedy, Family","ic0intvXZSfBlYPIvWXpU1ivUCO.jpg",675445],["Flee",2021,4,1,"Jonas Poher Rasmussen","Documentary, Animation","vlMIbqOpYG553J1kOJXA7mwQvE6.jpg",680813],["The Long Goodbye (2020)",2020,2.5,1,"Aneil Karia","Drama, Thriller","8APp0RcuICPfgOiZWX5lnLYtOMZ.jpg",681015],["My Octopus Teacher",2020,3,1,"Pippa Ehrlich","Documentary","hvTVZb7hBC8tZAGoEhH5eiMJu2B.jpg",682110],["Earwig and the Witch",2020,1,1,"Goro Miyazaki","Animation, Fantasy, Family, Music, Comedy, TV Movie","9oK820JieICOcfUhI6mkpFrcA9m.jpg",683127],["Tom Merritt",1999,2.5,1,"Anders Gustafsson","Western, Romance","tKztlZ5K8n8J3GS39FjT3H15tmX.jpg",683877],["BARDO, False Chronicle of a Handful of Truths",2022,2.5,1,"Alejandro G. Iñárritu","Comedy, Drama","3e6RA0CzFDC0pz5TqiRlbHcsc2n.jpg",685691],["The Young Pope",2016,4,1,"Paolo Sorrentino","Documentary","lTqcZpoGMeNiy4uF8eiu3a7RM6L.jpg",685727],["Ascension",2021,3,1,"Jessica Kingdon","","9JyNcyDCO5GHHsmYWBOgOlU2519.jpg",685819],["Project Hail Mary",2026,4,1,"Phil Lord & Christopher Miller","Science Fiction, Adventure","yihdXomYb5kTeSivtFndMy5iDmf.jpg",687163],["The Making of 'Rushmore'",2000,2.5,1,"Eric Chase Anderson","Documentary, Comedy","xSbUGKueHLTCr8mxWflXVcEw42D.jpg",687173],["Feeling Through",2019,2,1,"Doug Roland","Drama","5sCBgrlDRAEH75RGwpwqEBlUNuo.jpg",689676],["Concatenation",2020,3,1,"Donato Sansone","Animation","zd7v3W4UwDPiP2SNcN3aMSxMWcO.jpg",689959],["Friends: The Reunion",2021,2,1,"Ben Winston","Documentary, Comedy","bT3c4TSOP8vBmMoXZRDPTII6eDa.jpg",691179],["Dune: Part Two",2024,5,2,"Denis Villeneuve","Science Fiction, Adventure","1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg",693134],["L'Homme Machine",1885,2.5,1,"Éric Rohmer","Documentary","nDCVFiHPApZXelgwZWNJYtbonVv.jpg",693308],["The Hunger Games: The Ballad of Songbirds & Snakes",2023,3,1,"Francis Lawrence","Science Fiction, Action","lrkOYL5GBTFW9cgs9RlojxAcZZF.jpg",695721],["Panda! Go Panda!",1972,3,1,"Isao Takahata","Comedy, Fantasy, Animation","ja31iFPODZSXwMnEEG4dpZC9S37.jpg",695839],["Mickey 17",2025,3.5,1,"Bong Joon Ho","Science Fiction, Comedy, Adventure","edKpE9B5qN3e559OuMCLZdW1iBZ.jpg",696506],["The Fairly OddParents: Abra Catastrophe! The Movie",2003,2.5,1,"Butch Hartman","Animation, Comedy, TV Movie, Family, Fantasy, Adventure","dCUYpEl4G2NY8ADM7lhUWSlAQUB.jpg",697932],["Nobody Knows I'm Here",2020,3.5,1,"Gaspar Antillo","Drama","c7CTxNNPeg6MH9VA9BBvMKdPmSh.jpg",698432],["Groovin' with Ken",2010,2.5,1,"Lee Unkrich","Animation, Comedy","ZXwdud1PBdIUZ3seb9H0YTALJF.jpg",701163],["Bugonia",2025,4,1,"Yorgos Lanthimos","Science Fiction, Thriller, Comedy","oxgsAQDAAxA92mFGYCZllgWkH9J.jpg",701387],["One Cut of the Dead – Mission: Remote",2020,3,1,"Shinichiro Ueda","Comedy","2uUBJeyH9ekG83BlQimmXNGa9Go.jpg",704565],["Decision to Leave",2022,3.5,1,"Park Chan-wook","Thriller, Mystery, Romance","N0rskx91Eh6aWjvBybeY6epNic.jpg",705996],["Nahuel and the Magic Book",2020,2.5,1,"Germán Acuña","Animation, Fantasy","vwWz3biJXjhJmn5WCjocGCVG3k2.jpg",706663],["Out",2020,2.5,1,"Steven Clay Hunter","Animation, Comedy, Drama, Fantasy, Family, Romance","dCmtnJqu4Lk4yzEPoLZkHYrpwaP.jpg",706860],["The Present",2020,3.5,1,"Farah Nabulsi","","lAa8xJpTeP1X84ZmFBdEXxpcldW.jpg",708049],["2001",2001,3.5,1,"Makoto Tezuka","Animation","aDPWGYyhO7mPpqEaUdwFkz2zAdt.jpg",710172],["Martin Scorsese's Quarantine Short Film",2020,2.5,1,"Martin Scorsese","Documentary","5fYlID0FNC3mGo0uMlI9E6lPxZ0.jpg",711439],["Evil Dead Rise",2023,3.5,2,"Lee Cronin","Horror, Thriller","5ik4ATKmNtmJU6AYD0bLm56BCVM.jpg",713704],["If Anything Happens I Love You",2020,2.5,1,"Will McCormack","Drama, Animation","85tDhACvKDQxQoJhBYLvDU0ik1n.jpg",713776],["Argentina 1985",2022,3.5,1,"Santiago Mitre","Drama, History, Crime","nmh7vD2eDVRqFJoCpEzVcfGcPPf.jpg",714888],["Night Ride",2020,1.5,1,"Eirik Tveiten","Drama","v8SQQt7vlyvEwimhUT273HeBD8v.jpg",715714],["Spencer",2021,4.5,2,"Pablo Larraín","Drama","7GcqdBKaMM9BWXWN07BirBMkcBF.jpg",716612],["Twins in Paradise",2020,4,1,"Victoria Vincent","Animation, Drama","ybfp4gjvsSZbJBQJR6r2JLss1z9.jpg",716668],["The Union",2017,3,1,"Lorena Giachino Torréns","","vIvO4Mk3tuBxN91Az0M2C4c5ZVJ.jpg",716904],["Pablo y Felipe",2012,3.5,1,"Samuel Sotomayor","Drama","r0sAuLL7vTwsrzfBPOReIlmcurm.jpg",717732],["Licorice Pizza",2021,4.5,2,"Paul Thomas Anderson","Drama, Comedy, Romance","ivXtvzfliGvoJ1DhSHIGyYBToWe.jpg",718032],["The Dress",2020,3,1,"Tadeusz Łysiak","Drama","80YQqGOqxr6wKBQOl3AsZW8O3iv.jpg",718142],["Lightyear",2022,3,1,"Angus MacLane","Animation, Science Fiction, Family, Adventure","b9t3w1loraDh7hjdWmpc9ZsaYns.jpg",718789],["Twisters",2024,3.5,1,"Lee Isaac Chung","Action, Thriller","50xgtaDR0xJkLSVghdTGUeMoPHP.jpg",718821],["Bullet Train",2022,3.5,1,"David Leitch","Action, Comedy, Thriller","j8szC8OgrejDQjjMKSVXyaAjw3V.jpg",718930],["Shishigari",2019,4,1,"Kiyotaka Oshiyama","Animation, Action, Adventure, Fantasy","kS2ViLxgKaPd9Stz2DQ5JPMcmNe.jpg",719087],["The Hand of God",2021,3.5,1,"Paolo Sorrentino","Drama","kreVxr5moB7K52IGGV1BGAn6nq1.jpg",722778],["Strasbourg 1518",2020,3.5,1,"Jonathan Glazer","Music","uMKUZOtfjcWqOzWSJZoK24kctg.jpg",722815],["Malcolm & Marie",2021,2.5,1,"Sam Levinson","Drama, Romance","bdidDnAZwchN5vTenoNuhGPJTri.jpg",722913],["Host",2020,2.5,1,"Rob Savage","Horror","h7dZpJDORYs5c56dydbrLFkEXpE.jpg",723072],["The Gray Man",2022,1.5,1,"Anthony Russo & Joe Russo","Action, Thriller","8cXbitsS6dWQ5gfMTZdorpAAzEH.jpg",725201],["Carly Rae Jepsen: Live at NHK Hall",2020,2.5,1,"","Music","rWlKjIviIOw8cm3BmMPEPbbMdX8.jpg",727807],["Omelia Contadina",2020,2,1,"Alice Rohrwacher","Documentary","oDET3wpW3XoXovWLF6UqDSR6QBY.jpg",728131],["World of Tomorrow Episode Three: The Absent Destinations of David Prime",2020,3.5,1,"Don Hertzfeldt","Animation, Science Fiction, Drama","a9ntSDEUqnSvZYEHDKzvjbhikoE.jpg",729775],["Cyrano",2021,2,1,"Joe Wright","Drama, Romance","e4koV8iC2cCM57bqUnEnIL2a2zH.jpg",730047],["The Earth Is Flat",2016,2.5,1,"Jonni Peppers","Animation, Fantasy, Comedy, Drama","9m8tEaFLfToQifSfsHmOJl5Uoo6.jpg",734930],["Broker",2022,3.5,1,"Hirokazu Kore-eda","Drama","x86xaUnxU31JYiwlO35corDEV1i.jpg",736732],["Aqua",2012,3,1,"Gints Zilbalodis","Animation","fkSviD9scF2fINVaYbgLfch6zDr.jpg",737520],["Borat Subsequent Moviefilm: Delivery of Prodigious Bribe to American Regime for Make Benefit Once Glorious Nation of Kazakhstan",2020,3.5,1,"Jason Woliner","Comedy","3L1Ml5RWjFVfVq3rQENvgFymT0U.jpg",740985],["Hoy es jueves cinematográfico",1978,3.5,1,"Ignacio Agüero","Family","iUjEZkq0e4wLDvmXl36029DvCsD.jpg",741445],["The Four Temperaments",2020,3,1,"Marco Brambilla","","tYtsjsD8K1UrPp2LCoXj0Dw51ve.jpg",741555],["Please Hold",2020,2,1,"K.D. Dávila","Science Fiction, Comedy","dhUvjNFwDcklGvbu5mKumtYBbz0.jpg",741607],["Colette",2020,2.5,1,"Anthony Giacchino","Documentary","lkMwjLzKBkhivbjH1af1ZRlNydX.jpg",741845],["Affairs of the Art",2021,2.5,1,"Joanna Quinn","Animation, Comedy","5vWn23tb9AYbhvpJMUrBLHIoUNn.jpg",742843],["The Flying Sailor",2022,2,1,"Wendy Tilby","Animation, Comedy, Fantasy, History","5pumyKicAZvivWihNcWDX8IBj4f.jpg",742872],["My Brothers Dream Awake",2021,3.5,1,"Claudia Huaiquimilla","Drama","6yeZMVI3iq1mak3qsQQYNLxfJ1u.jpg",743374],["When Evil Lurks",2023,3.5,1,"Demián Rugna","Horror, Thriller","iQ7G9LhP7NRRIUM4Vlai3eOxBAc.jpg",744857],["The Fall Guy",2024,2,1,"David Leitch","Action, Comedy, Romance","e7olqFmzcIX5c23kX4zSmLPJi8c.jpg",746036],["BoxBallet",2020,2,1,"Anton Dyakov","Animation, Romance","itMGtzYChYodWjZ1mBs5EPCDqPP.jpg",746080],["Kitty Love: An Homage to Cats",2020,0.5,1,"Mark Verkerk","Documentary","rw8F9pMIidylPA5QSh3jgPqFyaW.jpg",746712],["Burrow",2020,3,1,"Madeline Sharafian","Animation, Family, Comedy","zkQcHvMc7gVG6OWVotVLDeRkrRl.jpg",747059],["Asteroid City",2023,2.5,1,"Wes Anderson","Comedy, Drama","hfo7pvL9Fys7rocfL4VOzw9qDEQ.jpg",747188],["Toque de Queda",2019,3,1,"Carlos M. Velasco","Documentary","7kv4GzTuYuIxZ6dnk3NK7eOv4Y7.jpg",747561],["Positive Thinking",2020,4,1,"Carlos M. Velasco","Drama, Science Fiction, Horror","gRQq3DPEJ11mexyCdK3Gg170IYk.jpg",747563],["Petite Maman",2021,3,1,"Céline Sciamma","Drama, Fantasy","fxl2ARZO2vRfUGDfqSz2bostauE.jpg",749004],["Opera",2020,4,1,"Erick Oh","Animation","xpIIi8zBN26srXbloOBKPcF1XF2.jpg",750249],["La mujer de los gatos",2020,1,1,"Pedro Vodanovic","","svRvWfQVPfCHiqtoqAMLWhptmth.jpg",750545],["Extra Footage",2020,2.5,1,"Retham Ahmed","Drama","6WYqJFXSEwhbDD753nqxFRL2Yaa.jpg",750904],["Here Comes the Night Time",2013,2,1,"Roman Coppola","Music","8cqGV53EDHettGLsbxm2kemgfVP.jpg",753073],["Coming Out",2020,4,1,"Cressa Maeve Áine","Animation, Family, Fantasy","sj2Al9048Xn3HLxD6oHrEEoRL5z.jpg",753133],["Napoleon",2023,2.5,1,"Ridley Scott","History, War, Drama","ytFOXyghxLzAM4KZyazDdEkM66q.jpg",753342],["Mrs. Harris Goes to Paris",2022,3.5,1,"Anthony Fabian","Drama, Comedy, History","eUg0HDLhTEDcXGBU2iK6QRBILv4.jpg",754609],["Red, White and Blue",2020,3,1,"Steve McQueen","Drama","k0raZgIfYtooj0LDRGk1vTR6Fgr.jpg",755232],["Salomé",2020,2.5,1,"Luis Ortega","Fantasy","nZiYaZ7HERlZMRLxaAIcKypqJjz.jpg",755284],["The Black Phone",2021,3.5,1,"Scott Derrickson","Horror, Thriller","p9ZUzCyy9wRTDuuQexkQ78R2BgF.jpg",756999],["Peter's To-Do List",2019,2,1,"Jon Watts","Science Fiction, Action, Adventure","",758025],["Drive My Car",2021,3,1,"Ryusuke Hamaguchi","Drama","3cOsf5HBjPK2QCz9ebQlGHNnE7y.jpg",758866],["Hi, Mom",2021,2.5,1,"Jia Ling","Drama, Comedy, Fantasy","31W7qLEMqQKgdCeCtV9EbVi3bwG.jpg",758891],["Living",2022,3,1,"Oliver Hermanus","Drama","zUJcp0rpUqp2GSk7t9jvAiZsXtM.jpg",760099],["X",2022,3,1,"Ti West","Horror","lopZSVtXzhFY603E9OqF7O1YKsh.jpg",760104],["Orphan: First Kill",2022,3,1,"William Brent Bell","Horror, Thriller","pHkKbIRoCe7zIFvqan9LFSaQAde.jpg",760161],["The End of the Storm",2020,2.5,1,"James Erskine","Documentary","txGil2zkcVAeYWl8O6l8Pv7pl9K.jpg",760982],["Nope",2022,5,2,"Jordan Peele","Horror, Science Fiction","AcKVlWaNVVVFQwro3nLXqPljcYA.jpg",762504],["The Letter Room",2020,2.5,1,"Elvira Lind","Comedy","mdN8AnQxiM97GY6FxkZLQHbDPx7.jpg",762632],["Ambulance",2022,2,1,"Michael Bay","Thriller, Action, Drama, Crime","hUbgg3mMSbY9PlpTxBo4IFUVSd6.jpg",763285],["Red Rocket",2021,4.5,2,"Sean Baker","Drama, Comedy","345gLhiNpItU1ICx8OxJQwjgPmH.jpg",763329],["The Making of 'The Big Lebowski'",1998,2.5,1,"Richard Leyland","Documentary","rRwaCTF777WaBlrVxtuBic43oqC.jpg",763400],["Puparia",2020,4,1,"Shingo Tamagawa","Animation, Drama, Fantasy","3KRpbwNDrQ8cqKoVknoPqqtrpAO.jpg",766423],["Prey",2022,3.5,1,"Dan Trachtenberg","Thriller, Action, Science Fiction","2FKjLRt7oK1bRRIrxgWmthbBdFh.jpg",766507],["Parallel Mothers",2021,3,1,"Pedro Almodóvar","Drama","gDaxYkYNbHuM2VlUazbcpnFZB6d.jpg",766798],["The Strokes: MTV $2 Bill Concert",2002,4,1,"Roman Coppola","Music, Documentary, TV Movie","cp8sAG1sMLuy65HV3GykBKeR4f9.jpg",771104],["Death to 2020",2020,1.5,1,"Al Campbell","Comedy","w9FPFsPkeiBDn6WwDHFgniWdVJm.jpg",773655],["The Guardians of the Galaxy Holiday Special",2022,2.5,1,"James Gunn","Comedy, Science Fiction, Adventure","8dqXyslZ2hv49Oiob9UjlGSHSTR.jpg",774752],["Belle",2021,2.5,1,"Mamoru Hosoda","Animation, Science Fiction, Drama, Music","fYHOD4pxZQk4rsP2tQrZI5uBlZV.jpg",776305],["The Sparks Brothers",2021,4,1,"Edgar Wright","Documentary, Music","e8jtG3WS0Ku7Dh4fBne1rgriXZt.jpg",776485],["CODA",2021,3.5,2,"Sian Heder","Drama, Music, Romance","BzVjmm8l23rPsijLiNLUzuQtyd.jpg",776503],["Summer of Soul (...Or, When the Revolution Could Not Be Televised)",2021,3,1,"Questlove","Music, Documentary, History","8kNwhqUGvpzWJd60O1Qvb8G6psK.jpg",776527],["Writing with Fire",2021,2.5,1,"Rintu Thomas","Documentary, History","oM9og12G8vCNelCdM7bCW6pfrkW.jpg",776557],["Cryptozoo",2021,3,1,"Dash Shaw","Animation, Fantasy, Drama","xABkUfBl7YG0Z2uIkYMMd5SjTum.jpg",776660],["A Concerto Is a Conversation",2020,3,1,"Ben Proudfoot","Documentary, Music","beZ7Es8mXCqOPV9iGVeudQmhmLJ.jpg",776751],["When We Were Bullies",2021,2,1,"Jay Rosenblatt","Documentary","bFwYyveAYRF8M139IMORP2FWgad.jpg",776769],["31 Minutos: Yo Nunca Vi Televisión",2020,4,1,"Pedro Peirano & Álvaro Díaz González","Comedy, Family, Music","tcSXK2HVqNsSXeKM4VDYPtUBZ1c.jpg",777206],["Women Talking",2022,2.5,1,"Sarah Polley","Drama","wcTc9GveMMjAdHSlzdE0FaRCtqi.jpg",777245],["Belfast",2021,2.5,1,"Kenneth Branagh","Drama, History","3mInLZyPOVLsZRsBwNHi3UJXXnm.jpg",777270],["The Battle at Lake Changjin",2021,1.5,1,"Chen Kaige","Drama, War","iXvAlIo4DPLBiraC2KLu4977Wo2.jpg",779029],["Us Again",2021,3.5,1,"Zach Parrish","Animation, Drama, Family, Romance","zKnenwvQB6xA4mxc8zxL2S8qVbR.jpg",779047],["There's a Monster in My Kitchen",2020,3,1,"Tomm Moore","Animation","kKjbELflPpkXRAEHRx7rD0hdX91.jpg",779648],["Men",2022,2.5,1,"Alex Garland","Horror, Thriller, Fantasy","jo1Kv3P3UgDVk7JnUFr2Cl8WWUM.jpg",780609],["Víctor and the chosen ones",1996,2.5,1,"Juan Pablo Rebella & Pablo Stoll","Comedy","lQgDHMo4WM5pIWba15qWBI590YG.jpg",783477],["The Queen’s Gambit",2020,3.5,1,"","Documentary","gKxPyeItCrOscP8On4y5sG3WY9A.jpg",784047],["Bobo the Monkey",2021,3.5,1,"Victoria Vincent","Animation","uj59CDWa5x2eHY5oPOiJLvX99lq.jpg",784480],["The Whale",2022,3.5,1,"Darren Aronofsky","Drama","jQ0gylJMxWSL490sy0RrPj1Lj7e.jpg",785084],["EO",2022,3,1,"Jerzy Skolimowski","Drama, Adventure","1MK86Vr2nf1GSYOtRd8pFvA5RM8.jpg",785398],["Furiosa: A Mad Max Saga",2024,3.5,1,"George Miller","Action, Science Fiction, Adventure","iADOJ8Zymht2JPMoy3R7xceZprc.jpg",786892],["Two Distant Strangers",2020,1,1,"Travon Free","Drama","awnMWuq64kfzfKtNLctjBTJKqi0.jpg",787428],["Fresh",2022,1.5,1,"Mimi Cave","Horror, Thriller, Comedy","tlu71AgaL3EQBBCNGsAwZLPbV5D.jpg",787752],["Lamb",2021,3,1,"Valdimar Jóhannsson","Drama, Fantasy, Horror","gP9yviboTGWGolqUZKIB1UkF1C2.jpg",788929],["Mangrove",2020,3.5,1,"Steve McQueen","Drama","yBdJT7zkEDb7mlALiV6n7RGKB8b.jpg",788938],["Bones and All",2022,2.5,1,"Luca Guadagnino","Horror, Romance, Drama","dBQuk2LkHjrDsSjueirPQg96GCc.jpg",791177],["Zack Snyder's Justice League",2021,3,1,"Zack Snyder","Action, Adventure, Fantasy","tnAuB8q5vv7Ax9UAEje5Xi4BXik.jpg",791373],["Dumb Money",2023,2.5,1,"Craig Gillespie","History, Comedy, Drama","e9u7luSxFKOZgPTB9XHFnPArGdP.jpg",792293],["Poor Things",2023,5,2,"Yorgos Lanthimos","Science Fiction, Romance, Comedy","kCGlIMHnOm8JPXq3rXM6c5wMxcT.jpg",792307],["Groundhog Day for a Black Man",2016,2,1,"Cynthia Kao","Comedy, Drama","nuLaRFscW1HdJPfofukFWXYqwu1.jpg",793174],["Charli XCX: Alone Together",2021,3,1,"Bradley Bell","Documentary, Music","q2cGRdxcZu4PkjQxjOP8Z2CDXD9.jpg",795612],["Beau Is Afraid",2023,3.5,1,"Ari Aster","Comedy, Adventure, Fantasy","wgVkkjigF31r1nZV80uV0xNIoun.jpg",798286],["Better Man",2024,3,1,"Michael Gracey","Music, Drama","fbGCmMp0HlYnAPv28GOENPShezM.jpg",799766],["The Killer",2023,3.5,1,"David Fincher","Crime, Thriller","e7Jvsry47JJQruuezjU2X1Z6J77.jpg",800158],["Kimi",2022,3.5,1,"Steven Soderbergh","Thriller, Mystery, Crime","okNgwtxIWzGsNlR3GsOS0i0Qgbn.jpg",800510],["Dear Diary: World's First Pranks",2021,1.5,1,"Januel Mercado","Animation, Comedy, Family","1zCHghX3Nmy55UerNxd8cFLNXzh.jpg",801876],["KPop Demon Hunters",2025,2.5,1,"Maggie Kang","Fantasy, Music, Comedy, Animation","zT7Lhw3BhJbMkRqm9Zlx2YGMsY0.jpg",803796],["The Fabelmans",2022,4,1,"Steven Spielberg","Drama","h7llKkqkkJtJrTOaDLuVeUYDQ7I.jpg",804095],["Cocaine Bear",2023,2,1,"Elizabeth Banks","Thriller, Comedy, Crime","gOnmaxHo0412UVr1QM5Nekv1xPi.jpg",804150],["Beyond the Infinite Two Minutes",2020,3,1,"Junta Yamaguchi","Comedy, Science Fiction","kIKcksbl6dbmxTMS1wq15iFkBnB.jpg",805627],["The Son",2022,2,1,"Florian Zeller","Drama","hYR2doH3arnX0Y6WULuBPbtaLjN.jpg",806368],["Boiling Point",2021,3.5,1,"Philip Barantini","Drama, Thriller","kdkk7OBnIL1peW2zwcAAp6O54Jo.jpg",807196],["Hotheads",1993,3,1,"Jennie Livingston","Documentary, Comedy","ydW4GrXLhG20uU12t0WKNGRajBR.jpg",807390],["Honey Bunny",2001,2.5,1,"Vincent Gallo","Music","seyWrHoJPdXMRqLBahvLWSri7IE.jpg",808529],["Wake Up Dead Man",2025,3,1,"Rian Johnson","Thriller, Mystery, Comedy","qCOGGi8JBVEZMc3DVby8rUivyXz.jpg",812583],["Shin Kamen Rider",2023,2,1,"Hideaki Anno","Action, Drama, Science Fiction","9dTO2RygcDT0cQkawABw4QkDegN.jpg",813477],["Cha Cha Real Smooth",2022,2.5,1,"Cooper Raiff","Comedy, Drama, Romance","iUvoVhvwTlP8DofoqeIu7QAGLAe.jpg",814340],["Empire of Light",2022,2,1,"Sam Mendes","Drama, Romance","h84SnIQF91Gz2Fv1OpMJ3245t4i.jpg",814757],["Bottoms",2023,3.5,1,"Emma Seligman","Comedy","jeyTQrNEpyE1LZIgVlswYh3sc34.jpg",814776],["Correspondence",2020,3,1,"Dominga Sotomayor","Documentary","2GryC2c7k9i1GTDW3EmUksvIzzn.jpg",815101],["TÁR",2022,4.5,1,"Todd Field","Music, Drama","dRVAlaU0vbG6hMf2K45NSiIyoUe.jpg",817758],["The Fugitives",2021,3.5,1,"Maite Alberdi","Documentary","cvv5kvIDFueIF836foSHLFKgcWc.jpg",819576],["Crimes of the Future",2022,2.5,1,"David Cronenberg","Science Fiction, Horror, Thriller","RAFYMC0NgK9In9aGY6k6wsIL8w.jpg",819876],["Audible",2021,3,1,"Matthew Ogens","Documentary","8RjHHR0em5bHHEA6FsbMOj8EdFR.jpg",820492],["Tell It Like a Woman",2022,1,1,"MANY","Drama, Comedy, Action","s4tKbdmxXrPVH9QhznNKuCkHeaO.jpg",822124],["The Queen of Basketball",2021,3,1,"Ben Proudfoot","Documentary","8RjXNAvpH4SsBkEDRsCrEXxOcnd.jpg",822582],["To Leslie",2022,2.5,1,"Michael Morris","Drama","bFTgfsw4cnNjIZZ2r6P363X2Uk3.jpg",823147],["Flow",2024,4,1,"Gints Zilbalodis","Adventure, Animation, Family, Fantasy","zME0Ul0w48MKkYBnFRn40M5qgLh.jpg",823219],["Godzilla × Kong: The New Empire",2024,2,1,"Adam Wingard","Action, Adventure, Science Fiction","z1p34vh7dEOnLDmyCrlUVLuoDzd.jpg",823464],["Bo Burnham: Inside",2021,5,6,"Bo Burnham","Comedy, Drama","ku1UvTWYvhFQbSesOD6zteY7bXT.jpg",823754],["Something that happened in quarantine",2021,2,1,"Jorge Pinarello","Horror, Thriller, Comedy, Drama","7J3YXUzOo6CRFMerpwSNcxteohr.jpg",824559],["Everybody Dies in 90 Seconds",2008,2,1,"Mike Rianda","Animation, Comedy","",824924],["Three Songs for Benazir",2021,2.5,1,"Elizabeth Mirzaei","Documentary","4Q1P44IPm9FyxBH4vmxM7pRgopP.jpg",826740],["Beast",2021,5,1,"Hugo Covarrubias","Animation, Drama, Thriller","saVFC30IswbfopJSib3jBGfuwVf.jpg",828751],["Far from the Tree",2021,3,1,"Natalie Nourigat","Animation, Family","b3NhrYsr1X5r7zgjJDRMNOqXZS9.jpg",831827],["Val",2021,3.5,1,"Leo Scott","Documentary","vWJKmfmjpkFeTbUGep6t7w5TexA.jpg",834027],["La Chimera",2023,4,1,"Alice Rohrwacher","Drama, Fantasy, Comedy","lDaUha09CumsoSAt9MIRbS9WBNH.jpg",837335],["Robot Dreams",2023,4,1,"Pablo Berger","Animation, Drama, Comedy, Science Fiction","ds402Qq09ybgBcXKiQNTZfzsP5o.jpg",838240],["May December",2023,4,1,"Todd Haynes","Drama","zhV7B610l7hjlri4ywikJ18ONuq.jpg",839369],["The Holdovers",2023,4.5,1,"Alexander Payne","Drama, Comedy","VHSzNBTwxV8vh7wylo7O9CLdac.jpg",840430],["The Life of Chuck",2024,2.5,1,"Mike Flanagan","Fantasy, Drama","oumprkO9bThExP8NwxBIBnvBu2v.jpg",842924],["Daft Punk - Alive 2007 - Live Album Concert in Paris",2007,2.5,1,"","Music","bYA2Vln81U1PsLOGIMw9YzB3niP.jpg",843809],["SOUR Prom",2021,4,1,"Kimberly Stuckwisch","Music","hzou30lKM7G6IHAJ30SceYUGAHi.jpg",844198],["How Do You Measure a Year?",2021,2,1,"Jay Rosenblatt","Documentary","hoe1yeyRXbDFZXCxCQCxClGgh5y.jpg",846854],["Mad God",2021,3,1,"Phil Tippett","Animation, Fantasy, Horror, Science Fiction","105stT9GkiENXiYqvWYKoAuHKQL.jpg",846867],["The Bones",2021,3.5,1,"Cristóbal León & Joaquín Cociña","Animation, Horror","cZxkv8aMaC6B6XeqYWXMXM5HojF.jpg",848553],["Oasis: Knebworth 1996",2021,2.5,1,"Jake Scott","Documentary, Music","l2JnQl0ZSwHCl7zphwsEeM6HTDw.jpg",850490],["Happier Than Ever: A Love Letter to Los Angeles",2021,2.5,1,"Robert Rodriguez","Music, Documentary","m0f9sDiwYlEtfhUWxc5F2ZW7wfq.jpg",853088],["Ala Kachuu – Take and Run",2020,4,1,"Maria Brendle","Drama","mGGbm8IYURvkriTM924DoSCprBH.jpg",853760],["Becoming Led Zeppelin",2025,3,1,"Bernard MacMahon","Documentary, Music","cAxteOtjaeQN045qNNbSEwu78c4.jpg",857800],["EVANGELION: DEATH (TRUE)²",1998,3.5,1,"Hideaki Anno","Animation, Science Fiction, Action, Drama","AehyZFGm68ep76b81IbLJ1EJ5ot.jpg",857862],["I Saw the TV Glow",2024,3.5,1,"Jane Schoenbrun","Horror, Drama","hS4GYkYpN1rfl4GIxyc02sCyfAj.jpg",858017],["Hamnet",2025,4,1,"Chloé Zhao","Drama, Romance, History","61xMzN4h8iLk0hq6oUzr9Ts6GE9.jpg",858024],["Attica",2021,3,1,"Traci A. Curry","Documentary","8dpc49O7G9B0y2crRbI7hHtbQzB.jpg",858059],["Finde",2021,3.5,1,"Nano Garay Santalo","Comedy, Horror, Thriller","2MYEeM80Iy5MH81PqaOqsnQga7k.jpg",861717],["Rosa Rosae. A Spanish Civil War Elegy",2021,3,1,"Carlos Saura","Documentary, Animation","rsuCyNGGQQUVDi6m9cSlr67W5Nq.jpg",865388],["Lead Me Home",2021,2,1,"Jon Shenk","Documentary, Drama","rrsrOldUfXn5vd5HP3BAYxLTjpO.jpg",869602],["Marcel the Shell with Shoes On",2021,4,1,"Dean Fleischer Camp","Animation, Comedy, Drama, Family","jaYmP4Ct8YLnxWAW2oYkUjeXtzm.jpg",869626],["Oppenheimer",2023,4.5,1,"Christopher Nolan","Drama, History","8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",872585],["La Noche Boca Arriba",2012,3,1,"Hugo Covarrubias","Animation, Fantasy, History, Horror","k8j5YXMR3Fb1RoeBRuMHchHv2eG.jpg",879909],["No Hard Feelings",2023,3.5,1,"Gene Stupnitsky","Comedy, Romance","gD72DhJ7NbfxvtxGiAzLaa0xaoj.jpg",884605],["Deadstream",2022,3.5,1,"Joseph Winter","Horror, Comedy, Fantasy","dC38JMmb17geWFIjIBgNoKRMFnL.jpg",886083],["Joker: Folie à Deux",2024,2,1,"Todd Phillips","Drama, Crime, Thriller","aciP8Km0waTLXEYf5ybFK5CSUxl.jpg",889737],["Adieu Bohème",2017,3.5,1,"Jeanne Frenkel","Drama","qXQPjOZW6lMJMWlO94ki2jc1o9B.jpg",890750],["Werewolf by Night",2022,2.5,1,"Michael Giacchino","Action, Fantasy, Horror","mvIvNKRIJPPS7WSFarFhOAGIVnU.jpg",894205],["NYAD",2023,2,1,"Jimmy Chin","Drama, History","ydSqUhKFvg5cZ5OwImmf3K1R6SS.jpg",895549],["Rustin",2023,2,1,"George C. Wolfe","Drama, History","lCawCmTJhKT7c2ZOzLBTXDIR8JS.jpg",898713],["Golda",2023,1,1,"Guy Nattiv","Drama, History, War","fqOOLq12rOMCTcWzxaJ5VUROxp3.jpg",899524],["Close",2022,3,1,"Lukas Dhont","Drama","dlMNnWs7Mz8Nk5AC447Ew1tD5pn.jpg",901563],["Society of the Snow",2023,4,1,"J. A. Bayona","Drama, History","2e853FDVSIso600RqAMunPxiZjq.jpg",906126],["F1",2025,3.5,1,"Joseph Kosinski","Action, Drama","vqBmyAj0Xm9LnS1xe1MSlMAJyHq.jpg",911430],["The Imaginary",2023,3.5,1,"Yoshiyuki Momose","Animation, Adventure, Drama, Family, Fantasy","j2a9eQaoI91EuKnhGbE8yvPfmyV.jpg",913001],["Barbarian",2022,4.5,1,"Zach Cregger","Horror, Mystery, Thriller","idT5mnqPcJgSkvpDX7pJffBzdVH.jpg",913290],["A House Made of Splinters",2022,3,1,"Simon Lereng Wilmont","Documentary","eFYeFvco3Cgcrny99RCTFIaXMla.jpg",913743],["Fire of Love",2022,3,1,"Sara Dosa","Documentary","9smEX8UP84yb2GisLwyAyQKvCWS.jpg",913823],["All That Breathes",2022,2.5,1,"Shaunak Sen","Documentary, Drama","xgTyGlmOYnDwUugITwd8MY5AQ5F.jpg",913838],["Unter Menschen",2020,2.5,1,"Caren Wuhrer","Comedy","1v2HdHwqoeuiRtYvdFuvbAEAq3d.jpg",914195],["The Martha Mitchell Effect",2022,2.5,1,"Anne Alvergue","Documentary, Crime, History","gbv5THLM8FbvnPXUiRZQHdEiW6n.jpg",914268],["Fuelled",2021,2.5,1,"Michelle Hao","Animation, Drama, Thriller","xGhSqJfs0auqV46yLPeifL7JuUp.jpg",914533],["Anatomy of a Fall",2023,5,1,"Justine Triet","Thriller, Mystery, Crime","kQs6keheMwCxJxrzV83VUwFtHkB.jpg",915935],["The Quiet Girl",2022,4,1,"Colm Bairéad","Drama","6Njyz53N417cgxE0d7cBEWHUEjc.jpg",916405],["Beetlejuice Beetlejuice",2024,2,1,"Tim Burton","Comedy, Fantasy, Horror","kKgQzkUCnQmeTPkyIwHly2t6ZFI.jpg",917496],["On My Mind",2021,2.5,1,"Martin Strange-Hansen","Drama","3nDI3UCxdJrOo2jsT6gokFhfnDe.jpg",918627],["Edo Caroe: Orgía de Ornitorrincos",2023,2.5,1,"Gonzalo Pacheco","Comedy","tjYhX5HI1mxN7vagZtoo5DsleEO.jpg",922183],["The Beatles: Get Back",2021,4.5,1,"Peter Jackson","Music, Documentary","4MPsj31FTnfXg1NO93lzr3PqNuE.jpg",923403],["The Wonderful Story of Henry Sugar",2023,4.5,1,"Wes Anderson","Comedy, Fantasy, Adventure, Drama","fDUywEHwHh6nsLnVXAdPN9m4ZUG.jpg",923939],["Navalny",2022,2.5,1,"Daniel Roher","Documentary","9FXHNsqB4Wk9p42Yh0UtDflRY1f.jpg",926676],["Haulout",2022,2.5,1,"Maxim Arbugaev","Documentary","i1PH5y9umII7Vxb7StQtkA9Vd2n.jpg",926993],["Weird: The Al Yankovic Story",2022,3.5,1,"Eric Appel","Music, Comedy","qcj2z13G0KjaIgc01ifiUKu7W07.jpg",928344],["Wallace & Gromit: Vengeance Most Fowl",2024,3,1,"Nick Park","Animation, Adventure, Comedy, Science Fiction, Family","jUWFSBxTOiCinPdTOh3IDUXVemZ.jpg",929204],["Civil War",2024,4.5,1,"Alex Garland","War, Action, Drama","sh7Rg8Er3tFcN9BpKIPOMvALgZd.jpg",929590],["Saltburn",2023,2.5,1,"Emerald Fennell","Drama, Comedy, Thriller","zGTfMwG112BC66mpaveVxoWPOaB.jpg",930564],["Come Home",2021,2.5,1,"Garth Jennings","Comedy, Animation, Family, Music","yIwVPBD8w1HoJ9hVidzjQx0oEx2.jpg",931633],["Una película de Zombies",2022,0.5,1,"Cristobal Ross","Comedy, Horror","60vuurKdwySwlkw1nJ1bSfih5An.jpg",932147],["The Substance",2024,4.5,1,"Coralie Fargeat","Horror, Science Fiction, Thriller","lqoMzCcZYEFK729d6qzt349fB4o.jpg",933260],["Scream VI",2023,3,1,"Tyler Gillett & Matt Bettinelli-Olpin","Horror, Thriller, Crime","wDWwtvkRRlgTiUr6TyLSMX8FCuZ.jpg",934433],["Love is Blind",1926,3.5,1,"Lothar Mendes","","9kAlFdLgS4X1bAhB6jgFsYEGTWZ.jpg",936738],["A Man Called Otto",2022,2.5,1,"Marc Forster","Comedy, Drama","130H1gap9lFfiTF9iDrqNIkFvC9.jpg",937278],["Challengers",2024,4.5,1,"Luca Guadagnino","Drama, Romance","H6vke7zGiuLsz4v4RPeReb9rsv.jpg",937287],["Late Night with the Devil",2023,3.5,1,"Cameron Cairnes","Horror","mu8LRWT9GHkfiyHm7kgxT6YNvMW.jpg",938614],["OLIVIA RODRIGO: driving home 2 u (a SOUR film)",2022,3.5,1,"Stacey Lee","Music, Documentary","v8tVvNTIDL2KP7a5iLDtqF2NhNL.jpg",939790],["Godzilla Minus One",2023,4.5,3,"Takashi Yamazaki","Science Fiction, Horror, Action","2E2WTX0TJEflAged6kzErwqX1kt.jpg",940721],["TVM: It´s Fucking Rolling",2023,2,1,"Gonzalo Pacheco","Comedy","jLpOGtBfo2Bn8RZneTXUCFvE2jA.jpg",942228],["An Ostrich Told Me the World Is Fake and I Think I Believe It",2022,3.5,1,"Lachlan Pendragon","Animation, Comedy","a0xrTLwvosW81fuFhdWYdu35GJ0.jpg",943776],["A Haunting in Venice",2023,2,1,"Kenneth Branagh","Mystery, Thriller, Crime","l6iwxT0NbVw6QiF08YTIuTnXS82.jpg",945729],["Alien: Romulus",2024,3.5,1,"Fede Álvarez","Horror, Science Fiction","2uSWRTtCG336nuBiG8jOTEUKSy8.jpg",945961],["My Old Ass",2024,3,1,"Megan Park","Drama, Comedy","yUs4Sw9AyTg2sA1qWBkNpD2mGSj.jpg",947891],["Pearl",2022,4,1,"Ti West","Horror, Drama, Thriller","z5uIG81pXyHKg7cUFIu84Wjn4NS.jpg",949423],["floatland",2018,4,1,"Victoria Vincent","Animation","hfL1JzqecRiWichXHX25r4hKimr.jpg",950002],["A Minecraft Movie",2025,2,1,"Jared Hess","Family, Fantasy, Comedy, Adventure","yFHHfHcUgGAxziP1C3lLt0q2T4s.jpg",950387],["Letter to a Pig",2022,3,1,"Tal Kantor","Animation","fu5xL4pEFBOt8FhDgCqyeDICTqt.jpg",950810],["Pachyderm",2022,3,1,"Stéphanie Clément","Animation, Drama","kmXoJpg0Zu3r1RoupIvyXWLcJeq.jpg",950822],["AURORA - Live in Nidarosdomen",2017,4,1,"Robin Sletthagen","Music, TV Movie","mynCRZVXVQizvt8GmJ4sWjrfdP8.jpg",952279],["Jerrod Carmichael: Rothaniel",2022,3.5,1,"Bo Burnham","Comedy, Documentary","klYNX97TLtWz4zfaByWsoLH2BGT.jpg",952326],["Drive-Away Dolls",2024,2.5,1,"Joel Coen & Ethan Coen","Comedy, Crime","6QPKmqntFgLm6sB47AtSelEGGPM.jpg",957304],["Moonage Daydream",2022,4,1,"Brett Morgen","Documentary, Music","tJCZI1tO0sYIV0mGo0Awcr996vm.jpg",957457],["Antiporno",2016,4.5,1,"","Documentary","wEAE5e2ElAfjlWsE0VhJUgS0jq5.jpg",959305],["Nimona",2023,2.5,1,"Troy Quane","Animation, Family, Fantasy, Adventure, Science Fiction, Action","2NQljeavtfl22207D1kxLpa4LS3.jpg",961323],["When Billie Met Lisa",2022,1,1,"David Silverman","Animation, Comedy, Music","nNplaMrD69kilWOowsBp9rmpd3O.jpg",962659],["Strange Way of Life",2023,3.5,1,"Pedro Almodóvar","Drama, Western, Romance","uKOSFVplHUtvjtDEE5N4x8Hs9vL.jpg",963765],["Stranger at the Gate",2022,2,1,"Joshua Seftel","Documentary","iGRoSUZxLib49O9xcEvBw9PlEKs.jpg",964789],["Air",2023,3,1,"Ben Affleck","Drama, History","76AKQPdH3M8cvsFR9K8JsOzVlY5.jpg",964980],["Aftersun",2022,4,1,"Charlotte Wells","Drama","evKz85EKouVbIr51zy5fOtpNRPg.jpg",965150],["Ice Merchants",2022,3.5,1,"João Gonzalez","Animation, Drama","uDoiGF4KqyNglxaIJlRWdFQ4WJT.jpg",965171],["Barely Legal Pawn",2014,2.5,1,"Lucia Aniello","Comedy","iuALuHQAYQpw9aMJny9qLTmSSiX.jpg",965386],["My Year of Dicks",2022,3,1,"Sara Gunnarsdóttir","Animation, Comedy","pJDxugqyIjvwrhQdnYuCeMzEpAu.jpg",971188],["Knight of Fortune",2022,3,1,"Lasse Lyskjær Noer","Comedy, Drama","dHEq36Jmp7UrEq1mBMOyZLmhNcj.jpg",971468],["Tuesday",2015,3.5,1,"Charlotte Wells","Drama","6rXS2bmPq1exJnZPMXjlQmiwe9s.jpg",972611],["Conclave",2024,3,1,"Edward Berger","Drama, Thriller","m5x8D0bZ3eKqIVWZ5y7TnZ2oTVg.jpg",974576],["Le Pupille",2022,4,1,"Alice Rohrwacher","Family, Comedy","tuee2So5p4zWbEznpL8EKRT4cre.jpg",974586],["Totally Killer",2023,2,1,"Nahnatchka Khan","Horror, Comedy, Science Fiction","52YBwGJ3cJs54fpBzwnT1lnqgTo.jpg",974931],["Emilia Pérez",2024,1.5,1,"Jacques Audiard","Drama, Thriller","7seqaCaaXDNUHOx4DqwpoOH8pPa.jpg",974950],["Elemental",2023,2.5,1,"Peter Sohn","Animation, Comedy, Family, Romance","4Y1WNkd88JXmGfhtWR7dmDAo1T2.jpg",976573],["Perfect Days",2023,4.5,1,"Wim Wenders","Drama","tvUHVSTJV9ITON3oyHaWp7oaAc8.jpg",976893],["The Fire Within: A Requiem for Katia and Maurice Krafft",2022,3.5,1,"Werner Herzog","Documentary","i1LgOPrUq40dvCVo5oWX0XNqoQa.jpg",977341],["We Cry Together",2022,3,1,"Dave Free","Drama, Music","9xCTaPFhQWMI1NQdzkyZ2UNsE1E.jpg",983690],["Catopolis",2022,3.5,1,"Victoria Vincent","Animation, Drama","kiVhY4bBJN8JTNxqNvYtYDpKurE.jpg",984824],["Theater Camp",2023,3,1,"Nick Lieberman","Comedy","2osbLk1MMt9qjXPKSB2hMcBUyrw.jpg",986054],["Thunderbolts*",2025,3,1,"Jake Schreier","Action, Science Fiction, Adventure","hqcexYHbiTBfDIdDWxrxPtVndBX.jpg",986056],["Fallen Leaves",2023,4,1,"Aki Kaurismäki","Romance, Drama, Comedy","9ayYOpeqHhxfHHUoyt3kXzznECO.jpg",986280],["Black Country, New Road: 'Live from the Queen Elizabeth Hall'",2022,3,1,"Simon Hanning","Music","3Opb7Rqsh5G5kHNB0rYLusM4Jlq.jpg",986345],["A Different Man",2024,3.5,1,"Aaron Schimberg","Comedy, Drama","lZZKTEvo92u1J5pm7QoEA5yN3du.jpg",989662],["El Conde",2023,2.5,1,"Pablo Larraín","Fantasy, Comedy, Horror","5tcbdLbMzYEMBeJwf5PWcgUnmVa.jpg",991708],["Lisa Frankenstein",2024,2.5,1,"Zelda Williams","Horror, Comedy, Romance","jAW7ZdIm4HLKB3g15uMOWYNdU8r.jpg",993784],["The Boy, the Mole, the Fox and the Horse",2022,2.5,1,"Charlie Mackesy","Animation, Family, Drama, Adventure","wAKBWRhMmBtrCCuqmFwPm2RGTph.jpg",995133],["31 Minutos: Don Quijote",2021,3.5,1,"Pedro Peirano & Álvaro Díaz González","Comedy, Music, Family, TV Movie","uE2EomfekGVh8S0S5k8aEamUFz4.jpg",996181],["31 Minutos: Romeo y Julieta",2020,3,1,"Pedro Peirano & Álvaro Díaz González","Music, Family, Comedy","5gGzLeCw8ra3DG85BQBhfasGRGz.jpg",996205],["Kali Uchis: LIVE // EN VIVO (Call Me If You Get Lost Tour)",2022,2.5,1,"Nicolás Sandino Moreno","","nlGCoWKEZQMds1mOyGD1lOQvRVG.jpg",997581],["The Teachers' Lounge",2023,4,1,"İlker Çatak","Drama","kWXA6PfQ0PpZpoCXoeBFRciRrUw.jpg",998022],["I'm Still Here",2024,4.5,1,"Walter Salles","Drama, History","gZnsMbhCvhzAQlKaVpeFRHYjGyb.jpg",1000837],["Eating Sea Urchins",1930,2,1,"Luis Buñuel","Documentary","5tRZslo7cT0bqifGA1uP2hQ4HtE.jpg",1004399],["All the Beauty and the Bloodshed",2022,4,1,"Laura Poitras","Documentary","cvO51xxtIUHc5w5ZgFsigiFaUaO.jpg",1004663],["Bobi Wine: The People's President",2022,2.5,1,"Christopher Sharp","Documentary","gehzAC8zE85Qiyn5HcXgiky7W1W.jpg",1004683],["Bo Burnham: The Inside Outtakes",2022,3.5,1,"Bo Burnham","Comedy, Music","tSHY7F5QLlJOnf1Ox9tYZc3YVOB.jpg",1005159],["Kendrick Lamar Live: The Big Steppers Tour",2022,3,1,"Dave Free","Music, Documentary","2o2xNyQiInK4ze9sOQ5pbGEpZCY.jpg",1007028],["Nobody 2",2025,2.5,1,"Timo Tjahjanto","Action, Thriller, Comedy, Crime","svXVRoRSu6zzFtCzkRsjZS7Lqpd.jpg",1007734],["Talk to Me",2022,3.5,1,"Michael Philippou","Horror, Thriller","kdPMUMJzyYAc4roD52qavX0nLIC.jpg",1008042],["31 Minutos: Especial de Navidad",2003,4,1,"Pedro Peirano & Álvaro Díaz González","Comedy, Family, TV Movie","fGNmKriRp5hJ76Ie8Xp88lZAQJI.jpg",1012785],["Hard Truths",2024,4,1,"Mike Leigh","Drama, Comedy","eEj1TGrGc4IQ8bscFC17Ggdg6ft.jpg",1013154],["A Real Pain",2024,3.5,1,"Jesse Eisenberg","Comedy, Drama","67xRIXm5TxXRT4nV2V4AEJ9yq2d.jpg",1013850],["Hundreds of Beavers",2022,4.5,1,"Mike Cheslik","Comedy, Adventure","qgXS9HrYaYDnILeXebatCbtX9IP.jpg",1019939],["Priscilla",2023,4,1,"Sofia Coppola","Drama, Romance","uDCeELWWpsNq7ErM61Yuq70WAE9.jpg",1020006],["Inside Out 2",2024,3.5,1,"Kelsey Mann","Animation, Adventure, Comedy, Family","vpnVM9B6NMmQpWeZvzLvDESb2QY.jpg",1022789],["Kate Berlant: Cinnamon in the Wind",2022,2.5,1,"Bo Burnham","Comedy","ykApVWnRSBTFmgpQ0W6l2MhblwM.jpg",1024961],["Nickel Boys",2024,3,1,"RaMell Ross","Drama, History","lu2vmmtStmTNMmSZl2LgrrQpLZo.jpg",1028196],["Kinds of Kindness",2024,3.5,1,"Yorgos Lanthimos","Comedy, Drama, Horror","50lPmjIpDs8gKfgK7fPIeKzpllh.jpg",1029955],["The Red Suitcase",2022,4,1,"Cyrus Neshvad","Thriller","q5rDJbK3xArtPK0nnmS3aAFi0pG.jpg",1032734],["The Eternal Memory",2023,4,1,"Maite Alberdi","Documentary","dKIcHpK6EtKocvE2PHVfmkYtrdK.jpg",1032760],["Die My Love",2025,3.5,1,"Lynne Ramsay","Drama","kajpShbFhOdpl6yCrLezMrr9tB4.jpg",1033148],["Premonitions Following an Evil Deed",1995,3.5,1,"David Lynch","Horror","lcrZxQButYmTtOPV79g89th5K8P.jpg",1033807],["There's Something in My Room",2013,2,1,"Joseph Winter","Horror, Comedy","iFsRVoYOzTEbfk96I0g8HCemqZk.jpg",1034123],["The Naked Gun",2025,3,1,"Akiva Schaffer","Comedy, Crime, Action","rmwQ8GsdQ1M3LtemNWLErle2nBU.jpg",1035259],["Ninety-Five Senses",2022,3.5,1,"Jared Hess","Animation, Drama","A6OsRYbbAglRu7W3z9NM83acr2O.jpg",1040371],["The Elephant Whisperers",2022,1.5,1,"Kartiki Gonsalves","Documentary","rRn0Uj2WXal7FkWWyKK0bleQlOy.jpg",1041580],["Ivalu",2023,2,1,"Anders Walter","Drama","8xCrLSfayOEEK2uMyDN191pqURg.jpg",1042171],["Monster (2023)",2023,4.5,1,"Hirokazu Kore-eda","Mystery, Thriller, Drama","kvUJUyUGOhEoiWWNH04IXoExPE2.jpg",1050035],["One Battle After Another",2025,4.5,1,"Paul Thomas Anderson","Thriller, Crime, Comedy","m1jFoahEbeQXtx4zArT2FKdbNIj.jpg",1054867],["Modern Love: Falling in Love at 71",2013,2.5,1,"Arthur Jones","Animation","",1055604],["American Fiction",2023,4,1,"Cord Jefferson","Comedy, Drama","57MFWGHarg9jid7yfDTka4RmcMU.jpg",1056360],["20 Days in Mariupol",2023,3.5,1,"Mstyslav Chernov","Documentary, War","zIRp1IeuPh4GgqFCH3y0DQuY9xP.jpg",1058616],["Rotting in the Sun",2023,4,1,"Sebastián Silva","Comedy, Thriller","n2UhXsV5W2IlVdCRSxtK7hNa83s.jpg",1058696],["STILL: A Michael J. Fox Movie",2023,3,1,"Davis Guggenheim","Documentary","fDO4gYZxvdsIrHKzsSAbc3N7Wfg.jpg",1058699],["Superman (2025)",2025,3.5,1,"James Gunn","Science Fiction, Adventure, Action","wPLysNDLffQLOVebZQCbXJEv6E6.jpg",1061474],["Frankenstein (2025)",2025,3,1,"Guillermo del Toro","Drama, Fantasy, Horror","g4JtvGlQO7DByTI6frUobqvSL3R.jpg",1062722],["Anora",2024,5,1,"Sean Baker","Drama, Comedy, Romance","cgXk2tNYhJZLXdBDO5DidAVzQ82.jpg",1064213],["Memoir of a Snail",2024,4,1,"Adam Elliot","Animation, Comedy, Drama","woaN8CbloH0akyX0E72ayxlJAB4.jpg",1064486],["Fist of the Condor",2023,2.5,1,"Ernesto Díaz Espinoza","Action","odpaGY2lG32NG4GL2PuGPt7UUTy.jpg",1064517],["Four Daughters",2023,3.5,1,"Kaouther Ben Hania","Documentary, Drama","iSpJ6fg1OOSO30IUkZskZDufVzN.jpg",1069193],["Making The Worst Person in the World",2022,3.5,1,"","Documentary","yfoudnQdfTkg1eibIovxNBSasI9.jpg",1072303],["How to Have Sex",2023,3.5,1,"Molly Manning Walker","Drama","yQyoFCBLGJH5HXESmJAzaiXw9zU.jpg",1075175],["Weapons",2025,3.5,1,"Zach Cregger","Horror, Mystery","cpf7vsRZ0MYRQcnLWteD5jK9ymT.jpg",1078605],["Backrooms",2026,3.5,1,"Kane Parsons","Horror, Mystery, Science Fiction","rhGx6E3qRNMgj3i5su2oukNHwIQ.jpg",1083381],["Companion",2025,3,1,"Drew Hancock","Horror, Science Fiction, Thriller","oCoTgC3UyWGfyQ9thE10ulWR7bn.jpg",1084199],["Zootopia 2",2025,3,1,"Byron Howard","Animation, Adventure, Comedy, Mystery, Family","oJ7g2CifqpStmoYQyaLQgEU32qO.jpg",1084242],["Invincible",2022,4,1,"Vincent René-Lortie","Drama","6FLCoMN4Ah5j2D6niuYQ85NAi27.jpg",1084765],["Sit Still",2021,2,1,"Vincent René-Lortie","Drama","yF3aKoJGCy01zBtjrea1mndackl.jpg",1085463],["Nǎi Nai & Wài Pó",2023,2.5,1,"Sean Wang","Documentary","uHYoNVM5vhgTO7zYgDsQsewEYLO.jpg",1085779],["Bitter Christmas",2026,3,1,"Pedro Almodóvar","Drama, Comedy","q030Fi4tubXBJKg3D9otPDgGP2o.jpg",1088548],["The Tale of Thomas Burberry",2016,2,1,"Asif Kapadia","Drama","yDgkYd39eoALl1GDTAJpaC59qpN.jpg",1100436],["Fiona Apple: MTV Unplugged",1997,3.5,1,"Beth McCarthy-Miller","Music, Documentary","",1104825],["Kill the Jockey",2024,4.5,1,"Luis Ortega","Comedy, Crime, Drama","2CGm69ebTBnbqFZIT8cWSuRIb8S.jpg",1104937],["Juror #2",2024,4,1,"Clint Eastwood","Drama, Thriller","ugQkpGajKFQ8eyOEhGheR0HfWQ.jpg",1106739],["The Chair",2022,3,1,"Curry Barker","Horror","1amnNMQoEqqSCgJiMlT3cptAe2u.jpg",1118403],["Sentimental Value",2025,4.5,1,"Joachim Trier","Drama","pz9NCWxxOk3o0W3v1Zkhawrwb4i.jpg",1124566],["The Monkey",2025,2.5,1,"Osgood Perkins","Horror, Comedy","yYa8Onk9ow7ukcnfp2QWVvjWYel.jpg",1124620],["WHAM!",2023,3,1,"Chris Smith","Documentary, Music","mQbva3zRZz2f6Vuov0RmevYsolj.jpg",1134865],["The Hyperboreans",2024,3.5,1,"Cristóbal León & Joaquín Cociña","Animation, Science Fiction, Fantasy","6wXVMkWjEh8NrYkRt98tFjxId1W.jpg",1134966],["Alien Island",2023,4,1,"Cristóbal Valenzuela","Documentary","8gFqDGynfejfbcrQWsBm0hfwISo.jpg",1135824],["The Phoenician Scheme",2025,3,1,"Wes Anderson","Comedy, Adventure, Crime","u2jxeYLXTYfu0bqJmnLGIgZswib.jpg",1137350],["Once Upon a Studio",2023,2.5,1,"Dan Abraham","Animation, Family, Fantasy, Drama, Comedy","aiy3G1cYWV3LgKZHY6a3jL8bjYL.jpg",1139087],["Black Country, New Road - “Live at Bush Hall”",2023,3.5,1,"Greg Barnes","Music, Documentary","42ldpK7Tj5LpR7frl2SSUepjwKO.jpg",1139769],["Presence",2024,2.5,1,"Steven Soderbergh","Drama, Horror, Thriller","xZIGHoHj0DF0zdibwa66cRWHdHO.jpg",1140535],["Our Uniform",2023,3,1,"Yegane Moghaddam","Animation, Documentary","snlg7HFl14pJLTROxdpG0i5EFDX.jpg",1140605],["Nirvanna the Band the Show the Movie",2025,4,1,"Matt Johnson","Comedy, Science Fiction, Adventure, Music","sm5TGX8WbnCd9Uo26cLyTxVwA1n.jpg",1154538],["Sing Sing",2023,3,1,"Greg Kwedar","Drama","s0TPyI8QlMiktEiq3JVhea0zFhM.jpg",1155828],["Roger Is a Serial Killer",2024,2,1,"Don Swaynos","Comedy, Horror","sbfEFHhMAs3Ia0Z5ipOhOjrWg2G.jpg",1157075],["Herschell Gordon Lewis: The Godfather of Gore",2019,2.5,1,"Sean Baker","Documentary","tINzRjZHXNDjRth5FxPzTHi9Vbw.jpg",1165052],["The After",2023,1,1,"Misan Harriman","Drama","35AwGdQZVGePtkUa1lD2OlRv4UL.jpg",1169455],["Guitar Fantasia",1982,3.5,1,"","Music","hdE15EHvKpKSok2NqrEAeIUVRyq.jpg",1171566],["Takanaka Super Live 2010",2011,3.5,1,"","Music","j6Rv60Ugnqz1B5ZdGZ71K8FWdjg.jpg",1171569],["Takanaka Super Live 2012",2013,3.5,2,"Shinji Uchino","Music","lgcWlm3AKYGFuoaZZSgpuM4f6zA.jpg",1171571],["Super Live (2021) - Debut 50th Anniversary ~ The Rainbow Goblins Final",2022,3.5,1,"Tsukasa Ito","Music","2pnCPUYS0dS36LFSObzt5bO6eqI.jpg",1171576],["Super Live 2020 - Rainbow Finger Dancin' - Christmas Special",2021,3.5,1,"Tsukasa Ito","Music","50I7h7BAyVunXVGsmxq278lsYf4.jpg",1171577],["Jungle Jane Tour Live",1986,4,1,"","Music","cbLVIEtp7wLa2Ozt2pewRuhAFH2.jpg",1171582],["American Symphony",2023,2.5,1,"Matthew Heineman","Documentary, Music","skfO62LOEg805x9fMYeEDQRorXP.jpg",1171816],["The Last Repair Shop",2023,4,1,"Ben Proudfoot","Documentary, Music","9BWy7bgE4nTXf7hhooFNqVBJXgU.jpg",1171861],["The Rat Catcher",2023,3.5,1,"Wes Anderson","Comedy","29WJ7dOHt48AtXK1J1rONEEvIMN.jpg",1172674],["The Swan",2023,3.5,1,"Wes Anderson","Drama","fRbx6DPdQBJrhZWyshjJABtAIyu.jpg",1172675],["Poison",2023,3.5,1,"Wes Anderson","Comedy, Drama, Thriller","IQG49DUJw5DsgcNbW0NfagiDOs.jpg",1172676],["Takanaka 40th Debut Anniversary - Super Collection",2012,4,2,"","Music","qIKvBWnBwQaSDrgDPfqj1vOJWsG.jpg",1179276],["Brasilian Skies 40th (Super Live 2018)",2019,3.5,1,"Mitsuru Saito","Music","eAgGQfEVpEWsdFKIq3cLLbWurLp.jpg",1180895],["Sal Disfruta: Año Nuevo",2000,3,1,"Sebastián Silva","","5jbuRRt8g9mekraOCBWd5Us3yU1.jpg",1181369],["Notebook of Names",2023,3.5,1,"Cristóbal León & Joaquín Cociña","Documentary","qThvUYxxBgAmG6nznhc9VfWIJ40.jpg",1184417],["The Wild Robot",2024,3,1,"Chris Sanders & Dean DeBlois","Family, Animation, Science Fiction, Adventure","wTnV3PCVW5O92JMrFvvrRcV39RU.jpg",1184918],["The ABCs of Book Banning",2023,2.5,1,"Sheila Nevins","Documentary","wcgYS6gv9dA0jBaQQft2eLjPAh0.jpg",1186227],["The Barber of Little Rock",2023,1.5,1,"John Hoffman","Documentary","eSikhf6EozXT94zCG4uX2eIuE16.jpg",1186247],["Red, White and Blue (2023)",2023,2.5,1,"Nazrin Choudhury","Drama","4h1fIQ1b5P21N7tt5dZWDNOjYD7.jpg",1194636],["31 Minutos: Los Policarpo Top Top Top Awards",2003,3,1,"Pedro Peirano & Álvaro Díaz González","Comedy, Family, TV Movie","hjVyKJpuwAhzWiqoQ6Ps7UBSPvp.jpg",1194882],["Novocaine",2025,3,1,"Dan Berk","Action, Comedy, Thriller","xmMHGz9dVRaMY6rRAlEX4W0Wdhm.jpg",1195506],["Now and Then - The Last Beatles Song",2023,2.5,1,"Oliver Murray","Documentary, Music","fxjpZXHMdR1XMO11HRUDt8ZtuCI.jpg",1196442],["Cold Trumpet",1963,2.5,1,"Enzo Nasso","Documentary, Music, Adventure","uKlWaIPKnsTevjs5owgPkvwAGcJ.jpg",1197929],["Send Help",2026,3.5,1,"Sam Raimi","Horror, Thriller, Comedy","zbJWVHOtj3ljBzWgL1P8pxP03Up.jpg",1198994],["Island in Between",2023,2,1,"S. Leo Chiang","Documentary","2tTXYn0BulJurNxtiSMV6eAfrTF.jpg",1203439],["An Irish Goodbye",2022,3.5,1,"Tom Berkeley","Drama","kMbj1Op9itS8CbSVk5KSjQy4lcC.jpg",1209878],["The Wind (2007)",2007,2.5,1,"Edward Yang","Animation","uNCkp0jRuGoxelEIketMtkuObip.jpg",1211654],["Eleanor the Great",2025,2,1,"Scarlett Johansson","Drama","9XTM42IJST6lwPxtK2iUwNaFvCT.jpg",1212271],["WAR IS OVER! Inspired by the Music of John & Yoko",2023,2,1,"Dave Mullins","Animation, Music, War","c8HG8jpjVa44hgMkVN91ZQ0Iw5B.jpg",1214020],["The Secret Agent",2025,4,1,"Kleber Mendonça Filho","Thriller, Drama, Crime","iLE2YOmeboeTDC7GlOp1dzh1VFo.jpg",1220564],["ME",2024,3.5,1,"Don Hertzfeldt","Animation, Drama, Science Fiction, Music","pnzQx2RyMM5DzHUfQZ5ouYOssRT.jpg",1223194],["history of japan",2016,3.5,1,"","","9QbhKIf1jKGNjDeXKZ3FymOeNpz.jpg",1223378],["Rainbow Goblins Story / Live at Budokan",1981,4.5,3,"","Music","iZiTG5U50iAQTgQdphhlEkJcrpl.jpg",1232433],["Sinners",2025,4,1,"Ryan Coogler","Horror, Action, Thriller","lOfjeJMKS7cOaaTn6q3J0y2ypiA.jpg",1233413],["Black Bag",2025,3.5,1,"Steven Soderbergh","Drama, Mystery, Thriller","hHPovtU4b96LHcoeEwRkGHI5btw.jpg",1233575],["Grand Theft Hamlet",2024,3.5,1,"Sam Crane","Animation, Documentary","61pws82KZEssg883HG3kwN16cRw.jpg",1234397],["31 Minutes: One Hot Christmas",2025,3,1,"Pedro Peirano & Álvaro Díaz González","Family, Comedy, Adventure, Music","s5Y0qRZGgdbNsxshhuIwXyslUYc.jpg",1237082],["31 Minutos en la Teletón",2003,2,1,"Pedro Peirano & Álvaro Díaz González","Comedy, TV Movie, Family","7Tbyc84sZafWQ7g5ifWYOKXrRFz.jpg",1239214],["Moana 2",2024,2,1,"David G. Derrick Jr.","Adventure, Animation, Comedy, Family, Fantasy","aLVkiINlIeCkcZIzb7XHzPYgO6L.jpg",1241982],["Train Dreams",2025,4,1,"Clint Bentley","Drama","l3zS4YnpOi4usyEXGJMtxSqDDyb.jpg",1241983],["Predator: Badlands",2025,2.5,1,"Dan Trachtenberg","Action, Science Fiction, Adventure","pHpq9yNUIo6aDoCXEBzjSolywgz.jpg",1242898],["Look Back",2024,5,1,"Kiyotaka Oshiyama","Animation, Drama","4f2EcNkp1Mvp9wE5w7HKxcmACWg.jpg",1244492],["Foodlosslla",2024,3,1,"Takashi Yamazaki","Science Fiction, Action","d2ohItJVQIstbuziFGrIjAbSNt9.jpg",1255542],["The Wonderful Story of Henry Sugar and Three More",2024,4,1,"Wes Anderson","Comedy, Drama, Fantasy","8gBOtLTs0GNMEZnisAK132o5V67.jpg",1259365],["Baby Invasion",2024,1,1,"Harmony Korine","Crime, Thriller, Science Fiction, Action, Horror","vQUMVlgDzKjcTWn7WfZsA8UCAbE.jpg",1262740],["31 Minutos: Festival de Triviña",2013,4,1,"Pedro Peirano & Álvaro Díaz González","Music, Family, Comedy, TV Movie","zHL2ZXsw0DnfiJZ26Uw0EZsDEM9.jpg",1273000],["31 Minutos: Radio Guaripolo",2015,3,1,"Álvaro Díaz González","Music, Family, Comedy, TV Movie","kqWJ8i2Yluwzy2bxaHeCogGU3xX.jpg",1273298],["Five Ways to Get Rid of a Hickey",2024,3,1,"Colectivo Niñita Perversa","Drama, Animation","l9CkagpZSNntwBfnfABpAEXke1T.jpg",1278987],["A Trip to the Moon (1912)",1912,2,1,"Władysław Starewicz","Science Fiction","lCOGb3Bhsm36eW5l9ioaT4me44Z.jpg",1296367],["The Sheep Detectives",2026,3.5,1,"Kyle Balda","Comedy, Family, Mystery","iKy5460GdsoknM8ppmGlJbKxAKa.jpg",1301421],["Mon Laferte, I Love You",2024,4,1,"Joanna Reposi","Documentary, Music","sildryP1raUQgULCVVZ2hRuZWZu.jpg",1310735],["The Devil Wears Prada 2",2026,3,1,"David Frankel","Comedy, Drama","xTI42pmsP5EDnvsNJPEDubwWBQO.jpg",1314481],["Marty Supreme",2025,4.5,1,"Josh Safdie & Benny Safdie","Drama, Thriller","lYWEXbQgRTR4ZQleSXAgRbxAjvq.jpg",1317288],["AURORA - Live at Corona Capital Festival",2021,3,1,"","","1lj3Ic2bmOXtHjWD8648djdN2g6.jpg",1330207],["Band of Brothers",2001,4,1,"","Documentary","u9C6q5DXJRxmkEt81FaRVuhgzfF.jpg",1335757],["Designation of Origin",2024,4,1,"Tomás Alzamora Muñoz","Comedy, Drama","9f4wnYhxt23sdfN8Sm2r0uv5Gvq.jpg",1338208],["Obsession",2025,4.5,1,"Curry Barker","Horror, Thriller","bRwnj8WEKBCvmfeUNOukJPwB43K.jpg",1339713],["El apagón: Aquí vive gente",2022,3.5,1,"Kacho López","Documentary, Music","bnfm9Ypqmy76pBrlurcQo6BBuJm.jpg",1352261],["A Nonsense Christmas with Sabrina Carpenter",2024,1.5,1,"Sam Wrench","Music, Comedy","w6gBjvivsWwTbvz0bBAIxszOnWL.jpg",1358820],["Great Lady Has an Interview",1954,1.5,1,"","TV Movie, Music","9GKQnrNZDV9nEJblJjlxXGfjKPi.jpg",1361165],["Olivia Rodrigo: GUTS World Tour",2024,3,1,"James B. Merryman","Music","sK892n6rLFHujmgKBrV8R3occif.jpg",1365141],["The Odyssey",2026,5,1,"Christopher Nolan","Adventure, Action, Fantasy","krVa7rKCQb4OBfsr2LTJv4rTz5q.jpg",1368337],["Predator: Killer of Killers",2025,3,1,"Dan Trachtenberg","Animation, Action, Science Fiction, Thriller","2XDQa6EmFHSA37j1t0w88vpWqj9.jpg",1376434],["La Coupe Bernard Tapine",2018,3,1,"Céline Sciamma","Documentary","gxITu7PoqchNdGxDwUG3wT36x1N.jpg",1376744],["An Evening with Dua Lipa",2024,2.5,1,"Paul Dugdale","Music, TV Movie","p96w68xvPhy74sdrnrrHtJHeX0q.jpg",1384789],["love letter to cinema",2024,3.5,1,"Carlos M. Velasco","Drama, Horror, Music","24QsGwVkwS5YYga15d6c2jjTuUk.jpg",1394539],["It’s Never Over, Jeff Buckley",2025,3.5,1,"Amy J. Berg","Documentary, Music","rrKe8bC6UKFKvfZHvbwA9Bq5hkR.jpg",1400381],["TONTO ESTÚPIDO HIJO DE PUTA NO SE DA CUENTA DE LA COSA",2024,2.5,1,"Carlos M. Velasco","Comedy","ufIYFgwtaWeC2J0oMOqRuihYFGH.jpg",1402661],["Couch Potato",2004,3,1,"Tomm Moore","Animation","5RkGm8pZmSGZUeAPNchiJLHw8bX.jpg",1441898],["Red Memory",2025,3,1,"Kiyotaka Oshiyama","Animation","wViFu33AZ67v8FuGVKcuXwTBngL.jpg",1454946],["It Was Just an Accident",2025,5,1,"Jafar Panahi","Drama, Thriller, Crime, Mystery","eNYGj2DG3n8OrVPTfYunpPW9uas.jpg",1456349],["agoraphobia",2017,3.5,1,"Victoria Vincent","Animation","8OnzxUI5kLU8zDgnNZGsVIJ1I3a.jpg",1469977],["Aspirational",2014,2.5,1,"Matthew Frost","Comedy","ifP4zNzGWQho9V7Zx8wb0F21aLV.jpg",1470275],["A Way In",2014,1.5,1,"Ruben Fleischer","Comedy","75jfZyPdxPy6ZHftySuGwiZsGsa.jpg",1476711],["Takanaka Super Live 2025 Black Ship in L.A.",2025,3.5,1,"","Music","AtdC6WdhHTG9aHJpZGS9Mbwxcij.jpg",1515863],["How to Shoot a Ghost",2025,2.5,1,"Charlie Kaufman","Fantasy","snUGvh5T2n6XfCTfw2Sqfj7kK8h.jpg",1517065],["Small Axe",2020,3.5,1,"Steve McQueen","","",1533099],["The Muppet Show",2026,2,1,"Alex Timbers","Comedy, Family, Music, TV Movie","tcwar1rL0neoLvnklL7DzYw7sN8.jpg",1548113],["Lo Mejor de 31 Minutos",2003,2.5,1,"Pedro Peirano & Álvaro Díaz González","Comedy, Family","piyqgL3koS40Jvt9z0jLWdqYf5t.jpg",1562022],["Making a Scene | 11 Performances",2013,1,1,"Janusz Kamiński","Drama, Comedy","lydTzre8JTqT6S7rHYsXyESRYi1.jpg",1564259],["EVANGELION 30th Anniversary Special Screening",2026,3.5,1,"Naoyuki Asano","Animation, Science Fiction, Comedy","25csgA1l0jpvvSRwdFgjrI7PDnk.jpg",1600672],["Beau",2011,2.5,1,"Ari Aster","","rfG3shH2lKEUJPOiQ1UaEctHPOI.jpg",1612055],["Neon Genesis Evangelion",1995,4.5,1,"Hideaki Anno","Animation, Drama","y2ah9t0navXyIvoHg1uIbIHO3tt.jpg",1614880],["On Your Mark",1995,4,1,"Hayao Miyazaki","Music, Fantasy, Animation","ZQkYbuMkUfPGn4ahD6PtetJu1A.jpg",1658826],["Kendrick Lamar's Super Bowl LIX Halftime Show",2025,4,1,"Hamish Hamilton","Music","hy7abI3UaI9k0eCjAwzFzQm4Yvr.jpg",1661819],["Jackals & Fireflies",2023,3,1,"Charlie Kaufman","Drama","w3Jy392Q7UPRJM908Fhuj0FbBgT.jpg",1675257],["George Harrison: Living in the Material World",2011,3.5,1,"Martin Scorsese","Documentary","xGo67G45tKvYd5aS8jHyaZxhEPT.jpg",1676821],["Tropico",2013,3.5,1,"Anthony Mandler","Music, Drama, Fantasy","qnDy87JiNcXrFCuiKzFYAx8x3w4.jpg",1688485],["BoJack Horseman Christmas Special: Sabrina's Christmas Wish",2014,3,1,"","","",1690121],["Devs",2020,3.5,1,"Alex Garland","","",1699476],["Billions Club Live with Olivia Rodrigo: A Concert Film",2026,2.5,1,"Sam Wrench","Music, Documentary","1tBAfhRPI9VP5igDDClbfGrXQDf.jpg",1702619],["The Tatami Galaxy",2010,4.5,1,"Masaaki Yuasa","","qoREIUxLZ3pAdwDQMljY4b6TjFR.jpg",1720111],["history of the entire world, i guess",2017,4,2,"","","",""],["Unedited Footage of a Bear",2014,3,1,"Alan Resnick","","",""],["Ani*Kuri15: Colonel Sports",2007,2,1,"","","",""],["Ani*Kuri15: The Big Race",2007,2,1,"","","",""],["Ani*Kuri15: Yurururu - Ordinary Chapter",2007,2.5,1,"","","",""],["Cowboy Bebop: The Movie",2001,3,1,"Shinichiro Watanabe","","",""],["Drop Dead Gorgeous",1999,3.5,1,"Michael Patrick Jann","","",""],["La guerre des étoiles",2025,2.5,1,"Coralie Fargeat","","",""],["Love, Death & Robots: The Witness",2019,3.5,1,"Alberto Mielgo","Science Fiction, Fantasy, Animation","",""],["Love, Death & Robots: Can't Stop",2025,1.5,1,"David Fincher","","",""],["Love, Death & Robots: How Zeke Got Religion",2025,3.5,1,"Diego Porral","","",""],["Love, Death & Robots: For He Can Creep",2025,3,1,"Emily Dean","","",""],["Love, Death & Robots: Spider Rose",2025,2.5,1,"Jennifer Yuh Nelson","","",""],["Love, Death & Robots: Smart Appliances, Stupid Owners",2025,2,1,"Patrick Osborne","","",""],["Love, Death & Robots: The Other Large Thing",2025,3.5,1,"Patrick Osborne","","",""],["Love, Death & Robots: Close Encounters of the Mini Kind",2025,3,1,"Andy Lyon","","",""],["Love, Death & Robots: 400 Boys",2025,2.5,1,"Robert Valley","","",""],["Love, Death & Robots: Golgotha",2025,1.5,1,"Tim Miller","","",""],["Love, Death & Robots: The Screaming of the Tyrannosaur",2025,2,1,"Tim Miller","","",""],["Muse",2025,2.5,1,"Paweł Pawlikowski","","",""],["Love, Death & Robots: Jibaro",2022,4,1,"Alberto Mielgo","","",""],["Love, Death & Robots: Mason's Rats",2022,3.5,1,"Carlos Stevens","","",""],["Love, Death & Robots: Bad Travelling",2022,3.5,1,"David Fincher","","",""],["Love, Death & Robots: The Very Pulse of the Machine",2022,3,1,"Emily Dean","","",""],["Love, Death & Robots: Kill Team Kill",2022,1.5,1,"Jennifer Yuh Nelson","","",""],["Love, Death & Robots: In Vaulted Halls Entombed",2022,2.5,1,"Jerome Chen","","",""],["Love, Death & Robots: Three Robots: Exit Strategies",2022,3,1,"Patrick Osborne","","",""],["Love, Death & Robots: Night of the Mini Dead",2022,4,1,"Robert Bisi","","",""],["Love, Death & Robots: Swarm",2022,2.5,1,"Tim Miller","","",""],["Qatar: el Mundial a sus pies",2022,3.5,1,"","","",""],["Don't Hug Me I'm Scared (2022)",2022,4,1,"Becky Sloan & Joseph Pelling","","",""],["Love, Death & Robots: Life Hutch",2021,1.5,1,"Alex Beaty","","",""],["Love, Death & Robots: All Through the House",2021,3.5,1,"Elliot Dear","","",""],["Love, Death & Robots: Pop Squad",2021,3.5,1,"Jennifer Yuh Nelson","","",""],["Love, Death & Robots: Snow in the Desert",2021,2,1,"Léon Bérelle","","",""],["Love, Death & Robots: Automated Customer Service",2021,3.5,1,"Meat Dept","","",""],["Love, Death & Robots: Ice",2021,3,1,"Robert Valley","","",""],["Love, Death & Robots: The Tall Grass",2021,2.5,1,"Simon Otto","","",""],["Love, Death & Robots: The Drowned Giant",2021,3.5,1,"Tim Miller","","",""],["Pretend It's a City",2021,3.5,1,"Martin Scorsese","","",""],["Pretend It’s a City",2021,3.5,1,"Martin Scorsese","","",""],["A Dog That Smokes Weed",2020,2.5,1,"Jonni Peppers","","",""],["Alex Wheatle",2020,3,1,"","","",""],["Homemade: Last Call",2020,3,1,"Pablo Larraín","","",""],["Long Toast",2020,2,1,"","","",""],["Normal People Confessions",2020,3,1,"Lenny Abrahamson","","",""],["The Weeknd: After Hours",2020,2.5,1,"","","",""],["Black Mirror: Rachel, Jack and Ashley Too",2019,1.5,1,"","","",""],["Black Mirror: Smithereens",2019,2.5,1,"","","",""],["Black Mirror: Striking Vipers",2019,2,1,"","","",""],["Love, Death & Robots: Fish Night",2019,2.5,1,"Damian Nenow","","",""],["Love, Death & Robots: Sonnie's Edge",2019,2.5,1,"Dave Wilson","","",""],["Love, Death & Robots: Suits",2019,1.5,1,"Franck Balson","","",""],["Love, Death & Robots: Shape-Shifters",2019,2,1,"Gabriele Pennacchioli","","",""],["Love, Death & Robots: The Secret War",2019,3,1,"István Zorkóczy","","",""],["Love, Death & Robots: The Dump",2019,1.5,1,"Javier Recio Gracia","","",""],["Love, Death & Robots: Lucky 13",2019,2,1,"Jerome Chen","","",""],["Love, Death & Robots: Helping Hand",2019,2.5,1,"Jon Yeo","","",""],["Love, Death & Robots: Beyond the Aquila Rift",2019,2.5,1,"Léon Bérelle","","",""],["Love, Death & Robots: Sucker of Souls",2019,3,1,"Owen Sullivan","","",""],["Love, Death & Robots: Zima Blue",2019,4,1,"Robert Valley","","",""],["Love, Death & Robots: Ice Age",2019,2,1,"Tim Miller","","",""],["Love, Death & Robots: Good Hunting",2019,3,1,"Dae Woo Lee","","",""],["Love, Death & Robots: Alternate Histories",2019,2,1,"Victor Maldonado","","",""],["Love, Death & Robots: When the Yogurt Took Over",2019,2.5,1,"Victor Maldonado","","",""],["Love, Death & Robots: Three Robots",2019,3,1,"Victor Maldonado","","",""],["Love, Death & Robots: Blindspot",2019,2.5,1,"Vitaliy Shushko","","",""],["Devilman Crybaby",2018,3,1,"Masaaki Yuasa","","",""],["Black Mirror: Arkangel",2017,2.5,1,"","","",""],["Black Mirror: Black Museum",2017,3,1,"","","",""],["Black Mirror: Crocodile",2017,3,1,"","","",""],["Black Mirror: Hang the DJ",2017,3.5,1,"","","",""],["Black Mirror: Metalhead",2017,2.5,1,"David Slade","","",""],["Black Mirror: USS Callister",2017,3.5,1,"","","",""],["Sherlock: The Lying Detective",2017,2,1,"","","",""],["Sherlock: The Six Thatchers",2017,2.5,1,"","","",""],["Black Mirror: Hated in the Nation",2016,3,1,"","","",""],["Black Mirror: Men Against Fire",2016,2.5,1,"","","",""],["Black Mirror: Nosedive",2016,3.5,1,"Joe Wright","","",""],["Black Mirror: Playtest",2016,2,1,"Dan Trachtenberg","","",""],["Black Mirror: San Junipero",2016,4,1,"","","",""],["Black Mirror: Shut Up and Dance",2016,3.5,1,"","","",""],["find true love",2016,3,1,"Victoria Vincent","","",""],["fluffy's third eye",2016,3,1,"Victoria Vincent","","",""],["Black Mirror: White Christmas",2014,3.5,1,"","","",""],["Sherlock: His Last Vow",2014,3,1,"","","",""],["Sherlock: The Empty Hearse",2014,3,1,"","","",""],["Sherlock: The Sign of Three",2014,3.5,1,"","","",""],["Black Mirror: Be Right Back",2013,3.5,1,"","","",""],["Black Mirror: The Waldo Moment",2013,2.5,1,"","","",""],["Black Mirror: White Bear",2013,3.5,1,"","","",""],["Top of the Lake",2013,3.5,1,"Jane Campion","","",""],["Sherlock: A Scandal in Belgravia",2012,4,1,"","","",""],["Sherlock: The Hounds of Baskerville",2012,3.5,1,"","","",""],["Sherlock: The Reichenbach Fall",2012,4,1,"","","",""],["Thingu",2012,4,1,"","","",""],["Black Mirror: Fifteen Million Merits",2011,4,1,"","","",""],["Black Mirror: The Entire History of You",2011,3.5,1,"","","",""],["Black Mirror: The National Anthem",2011,4,1,"","","",""],["Sherlock: A Study in Pink",2010,4,1,"","","",""],["Sherlock: The Blind Banker",2010,3.5,1,"","","",""],["Sherlock: The Great Game",2010,3.5,1,"","","",""],["David Lynch Cooks Quinoa",2007,4,1,"","","",""],["Werewolf Women of the S.S.",2007,2.5,1,"","","",""],["Watching Grass Grow",2005,2.5,1,"Don Hertzfeldt","","",""],["The Simpsons Christmas Special",1989,3.5,1,"David Silverman","","",""],["Fanny and Alexander (1984)",1984,4,1,"Ingmar Bergman","","",""],["Scenes from a Marriage (1973)",1973,4.5,1,"Ingmar Bergman","","",""],["kittykat96",2017,3.5,1,"Victoria Vincent","Animation, Drama, Horror","",""],["Sallie Gardner at a Gallop",1878,2.5,1,"","","",""]];

function computeInitialElo(rating, plays) {
  // rating: 0.5-5 stars, plays: veces vista
  const r = typeof rating === "number" ? rating : 2.5;
  const p = typeof plays === "number" ? plays : 1;
  const ratingBonus = (r - 2.5) * 100; // ±250 según nota
  const playsBonus = Math.min(p - 1, 10) * 10; // hasta +100 por rewatches
  return Math.round(START_ELO + ratingBonus + playsBonus);
}

// Inversa de la distribución normal estándar (función probit), aproximación
// racional de Peter Acklam — precisión ~1.15e-9. La usamos para "normalizar"
// el rating proyectado: en vez de asumir que el Elo ya es continuo y normal
// (no lo es — se amontona en valores redondos porque la mayoría de las
// pelis tuvo pocos duelos), convertimos cada Elo a su percentil real dentro
// del catálogo y pasamos ESE percentil por acá. El resultado es una campana
// genuinamente lisa por construcción, sin importar cómo esté agrupado el
// Elo de origen.
function probit(p) {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
      q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

// Pisa los movies locales con lo que haya en el Sheet (progreso + metadata
// de TMDB), y agrega las que estén en el Sheet pero no localmente. Se usa
// tanto al abrir la app (para no quedar pegado con datos viejos de otro
// dispositivo/navegador) como en el botón manual "restaurar desde el Sheet".
// Campos de metadata de TMDB que viajan igual en todos lados (pull, push,
// merge, alta de película nueva). "numeric: true" son los que deben
// quedar en null (no "") cuando no hay dato, para no romper comparaciones.
const META_FIELDS = [
  { key: "director" },
  { key: "genre" },
  { key: "poster" },
  { key: "tmdbId" },
  { key: "country" },
  { key: "originalLanguage" },
  { key: "runtime", numeric: true },
  { key: "overview" },
  { key: "collection" },
  { key: "productionCompanies" },
  { key: "voteAverage", numeric: true },
  { key: "voteCount", numeric: true },
  { key: "cast" },
  { key: "tagline" },
  { key: "backdrop" },
  { key: "imdbId" },
];

function mergeSheetIntoMovies(localMovies, sheetMovies) {
  const sheetMap = new Map(sheetMovies.map((m) => [m.title, m]));
  const localTitles = new Set(localMovies.map((m) => m.title));
  let updatedCount = 0;

  // El pull siempre trae el estado completo del Sheet, así que una peli
  // local que ya no aparece ahí fue borrada directamente en el Sheet
  // (fuera de la app) y hay que sacarla de la caché local también.
  const next = localMovies
    .filter((m) => sheetMap.has(m.title))
    .map((m) => {
      const existing = sheetMap.get(m.title);
      if (existing.elo == null) return m;
      updatedCount++;
      const merged = { ...m };
      META_FIELDS.forEach(({ key }) => {
        merged[key] = existing[key] || m[key];
      });
      merged.rating = existing.rating != null ? existing.rating : m.rating;
      merged.plays = existing.plays != null ? existing.plays : m.plays;
      merged.elo = existing.elo;
      merged.comparisons = existing.games || 0;
      merged.wins = existing.wins || 0;
      return merged;
    });

  const newOnes = [];
  sheetMovies.forEach((sm) => {
    if (!sm.title || localTitles.has(sm.title)) return;
    const movie = {
      id: uid(),
      title: sm.title,
      year: sm.year || undefined,
      rating: sm.rating,
      plays: sm.plays,
      elo: sm.elo != null ? sm.elo : computeInitialElo(sm.rating, sm.plays),
      comparisons: sm.games || 0,
      wins: sm.wins || 0,
    };
    META_FIELDS.forEach(({ key, numeric }) => {
      movie[key] = sm[key] || (numeric ? null : "");
    });
    newOnes.push(movie);
  });

  return { merged: [...next, ...newOnes], updatedCount, newCount: newOnes.length };
}

// TMDB guarda el idioma original como código ISO 639-1 (en, es, fr...).
// Mapeamos los más comunes en el catálogo a nombre legible; lo que no esté
// acá se muestra tal cual (código en mayúsculas) en vez de romper.
const LANGUAGE_NAMES = {
  en: "Inglés",
  es: "Español",
  fr: "Francés",
  it: "Italiano",
  de: "Alemán",
  ja: "Japonés",
  ko: "Coreano",
  zh: "Chino (mandarín)",
  cn: "Chino",
  pt: "Portugués",
  ru: "Ruso",
  sv: "Sueco",
  da: "Danés",
  no: "Noruego",
  fi: "Finlandés",
  pl: "Polaco",
  nl: "Neerlandés",
  hi: "Hindi",
  ar: "Árabe",
  tr: "Turco",
  he: "Hebreo",
  cs: "Checo",
  el: "Griego",
  hu: "Húngaro",
  ro: "Rumano",
  th: "Tailandés",
  fa: "Persa",
  uk: "Ucraniano",
  vi: "Vietnamita",
  id: "Indonesio",
  tl: "Tagalo",
};

function languageLabel(code) {
  if (!code) return "";
  return LANGUAGE_NAMES[code.toLowerCase()] || code.toUpperCase();
}

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Archivo:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap');`;

function Sprockets() {
  const holes = Array.from({ length: 14 });
  return (
    <div className="sprockets" aria-hidden="true">
      {holes.map((_, i) => (
        <span key={i} className="hole" />
      ))}
    </div>
  );
}

function CineEloApp() {
  const [movies, setMovies] = useState(null); // null = loading
  const [tab, setTab] = useState("comparar");
  const [newTitle, setNewTitle] = useState("");
  const [pair, setPair] = useState(null);
  // Orden en que se fue clickeando en un duelo de 3/4: mejor a peor,
  // en progreso hasta que solo queda una (que sale última automáticamente).
  const [rankingPicks, setRankingPicks] = useState([]);
  const [result, setResult] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState("");
  const [filterText, setFilterText] = useState("");
  const [debouncedFilterText, setDebouncedFilterText] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilterText(filterText), 250);
    return () => clearTimeout(t);
  }, [filterText]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [duelDirector, setDuelDirector] = useState("");
  const [duelGenre, setDuelGenre] = useState("");
  const [duelCountry, setDuelCountry] = useState("");
  const [duelLanguage, setDuelLanguage] = useState("");
  const [maxDuelosFilter, setMaxDuelosFilter] = useState(null); // null = sin tope
  const [duelGoldMin, setDuelGoldMin] = useState(1);
  const [duelGoldMax, setDuelGoldMax] = useState(10);
  const [duelSilverMin, setDuelSilverMin] = useState(0);
  const [duelSilverMax, setDuelSilverMax] = useState(10);
  const [winnerStaysMode, setWinnerStaysMode] = useState(false);
  const [loserStaysMode, setLoserStaysMode] = useState(false);
  const pendingChampionRef = useRef(null);
  const [showDirectorDuel, setShowDirectorDuel] = useState(false);
  const [directorDuelA, setDirectorDuelA] = useState("");
  const [directorDuelB, setDirectorDuelB] = useState("");
  const [biasedMode, setBiasedMode] = useState(null); // null | 'over' | 'under'
  const [tournament, setTournament] = useState(null); // null = sin torneo activo
  const [tournamentFilterGenre, setTournamentFilterGenre] = useState("");
  const [tournamentFilterDecade, setTournamentFilterDecade] = useState("all");
  const [tournamentFilterCountry, setTournamentFilterCountry] = useState("");
  const [tournamentFilterLanguage, setTournamentFilterLanguage] = useState("");
  const [duelRankMin, setDuelRankMin] = useState(1);
  const [duelRankMax, setDuelRankMax] = useState(0); // 0 = sin tope
  const [duelYearMin, setDuelYearMin] = useState(null);
  const [duelYearMax, setDuelYearMax] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showModes, setShowModes] = useState(false);
  const [rankFilterDirector, setRankFilterDirector] = useState("");
  const [rankFilterGenre, setRankFilterGenre] = useState("");
  const [rankFilterDecade, setRankFilterDecade] = useState("all");
  const [showRankFilters, setShowRankFilters] = useState(false);
  const [syncUrl, setSyncUrl] = useState(DEFAULT_SYNC_URL);
  const [syncUrlInput, setSyncUrlInput] = useState(DEFAULT_SYNC_URL);
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | syncing | ok | error
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const [bulkSyncProgress, setBulkSyncProgress] = useState(0);
  const [quickMode, setQuickMode] = useState(false);
  const [duelSize, setDuelSize] = useState(2);
  const [lastAction, setLastAction] = useState(null);
  const [duelCount, setDuelCount] = useState(0);
  const [rankHistoryCount, setRankHistoryCount] = useState(0);
  const [rankHistoryData, setRankHistoryData] = useState(null); // null = no cargado aún
  const [evoQuery, setEvoQuery] = useState("");
  const [evoDropdownOpen, setEvoDropdownOpen] = useState(false);
  const [evoSelectedIds, setEvoSelectedIds] = useState([]);

  // cargar preferencia de modo rápido
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("cine-elo-quick-mode", false);
        if (res && res.value) setQuickMode(res.value === "true");
      } catch (e) {
        // default false
      }
    })();
  }, []);

  const toggleQuickMode = () => {
    const next = !quickMode;
    setQuickMode(next);
    window.storage.set("cine-elo-quick-mode", String(next), false).catch(() => {});
  };

  // cargar preferencia de "ganador se mantiene" / "perdedor se mantiene"
  // (son excluyentes: activar una apaga la otra, no tiene sentido "mantener"
  // dos películas distintas a la vez).
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("cine-elo-winner-stays", false);
        if (res && res.value) setWinnerStaysMode(res.value === "true");
      } catch (e) {
        // default false
      }
    })();
    (async () => {
      try {
        const res = await window.storage.get("cine-elo-loser-stays", false);
        if (res && res.value) setLoserStaysMode(res.value === "true");
      } catch (e) {
        // default false
      }
    })();
  }, []);

  const toggleWinnerStays = () => {
    const next = !winnerStaysMode;
    setWinnerStaysMode(next);
    window.storage.set("cine-elo-winner-stays", String(next), false).catch(() => {});
    if (next && loserStaysMode) {
      setLoserStaysMode(false);
      window.storage.set("cine-elo-loser-stays", "false", false).catch(() => {});
    }
  };

  const toggleLoserStays = () => {
    const next = !loserStaysMode;
    setLoserStaysMode(next);
    window.storage.set("cine-elo-loser-stays", String(next), false).catch(() => {});
    if (next && winnerStaysMode) {
      setWinnerStaysMode(false);
      window.storage.set("cine-elo-winner-stays", "false", false).catch(() => {});
    }
  };

  // cargar torneo en curso, si había uno
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(TOURNAMENT_STORAGE_KEY, false);
        if (res && res.value) setTournament(JSON.parse(res.value));
      } catch (e) {
        // sin torneo guardado
      }
    })();
  }, []);

  const persistTournament = (t) => {
    if (t) {
      window.storage
        .set(TOURNAMENT_STORAGE_KEY, JSON.stringify(t), false)
        .catch(() => {});
    } else {
      window.storage.delete(TOURNAMENT_STORAGE_KEY, false).catch(() => {});
    }
  };

  const startTournament = (size) => {
    if (!movies) return;
    let pool = [...movies].filter((m) => Number(m.rating) !== 0);
    if (tournamentFilterGenre) {
      pool = pool.filter(
        (m) =>
          m.genre &&
          m.genre
            .split(",")
            .map((g) => g.trim())
            .includes(tournamentFilterGenre)
      );
    }
    if (tournamentFilterDecade !== "all") {
      const d = Number(tournamentFilterDecade);
      pool = pool.filter((m) => m.year && Math.floor(m.year / 10) * 10 === d);
    }
    if (tournamentFilterCountry) {
      pool = pool.filter(
        (m) =>
          m.country &&
          m.country
            .split(",")
            .map((c) => c.trim())
            .includes(tournamentFilterCountry)
      );
    }
    if (tournamentFilterLanguage) {
      pool = pool.filter((m) => languageLabel(m.originalLanguage) === tournamentFilterLanguage);
    }
    // Al azar entre todo el pool filtrado, no las N mejores por Elo — así
    // el torneo también puede sacar sorpresas en vez de ser siempre un
    // choque predecible entre las de arriba del ranking.
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const entrants = shuffled.slice(0, size);
    const hasFilter =
      tournamentFilterGenre ||
      tournamentFilterCountry ||
      tournamentFilterLanguage ||
      tournamentFilterDecade !== "all";
    if (entrants.length < size) {
      setError(
        `Necesitas al menos ${size} películas vistas${
          hasFilter ? " que cumplan el filtro elegido" : ""
        } para armar este torneo.`
      );
      return;
    }
    setError("");
    const t = createTournament(entrants, size);
    setTournament(t);
    persistTournament(t);
  };

  const resetTournament = () => {
    setTournament(null);
    persistTournament(null);
  };

  const chooseTournamentWinner = (winnerId) => {
    if (!tournament || !movies) return;
    const current = findCurrentTournamentMatch(tournament);
    if (!current) return;
    const winnerMovie = movies.find((m) => m.id === winnerId);
    const loserId = current.match.a === winnerId ? current.match.b : current.match.a;
    const loserMovie = movies.find((m) => m.id === loserId);
    if (!winnerMovie || !loserMovie) return;

    const expWinner = expectedScore(winnerMovie.elo, loserMovie.elo);
    const expLoser = expectedScore(loserMovie.elo, winnerMovie.elo);
    const winnerDelta = Math.round(getKFactor(winnerMovie.comparisons) * (1 - expWinner));
    const loserDelta = Math.round(getKFactor(loserMovie.comparisons) * (0 - expLoser));

    const next = movies.map((m) => {
      if (m.id === winnerId) {
        return { ...m, elo: m.elo + winnerDelta, comparisons: m.comparisons + 1, wins: m.wins + 1 };
      }
      if (m.id === loserId) {
        return { ...m, elo: m.elo + loserDelta, comparisons: m.comparisons + 1 };
      }
      return m;
    });
    setMovies(next);
    syncToSheet(next.filter((m) => m.id === winnerId || m.id === loserId));

    const nextTournament = advanceTournament(
      tournament,
      current.roundIdx,
      current.matchIdx,
      winnerId
    );
    setTournament(nextTournament);
    persistTournament(nextTournament);
  };

  // cargar tamaño de duelo guardado
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("cine-elo-duel-size", false);
        if (res && res.value) setDuelSize(Number(res.value));
      } catch (e) {
        // default 2
      }
    })();
  }, []);

  const changeDuelSize = (n) => {
    setDuelSize(n);
    setPair(null);
    window.storage.set("cine-elo-duel-size", String(n), false).catch(() => {});
  };

  // cargar contador de duelos
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("cine-elo-duel-count", false);
        if (res && res.value) setDuelCount(Number(res.value));
      } catch (e) {
        // default 0
      }
    })();
  }, []);

  // cargar cuántos cortes de historial hay guardados (solo para mostrar el contador)
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("cine-elo-rank-history", false);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          setRankHistoryCount(Array.isArray(parsed) ? parsed.length : 0);
        }
      } catch (e) {
        // sin historial todavía
      }
    })();
  }, []);

  const [resyncingHistory, setResyncingHistory] = useState(false);
  const [resyncMsg, setResyncMsg] = useState("");

  const [restoringFromSheet, setRestoringFromSheet] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState("");

  const restoreFromSheet = async () => {
    if (!syncUrl || !movies) return;
    setRestoringFromSheet(true);
    setRestoreMsg("");
    try {
      const pullRes = await fetch(`${syncUrl}?action=pull`);
      const pullData = await pullRes.json();
      if (!pullData || !pullData.ok || !Array.isArray(pullData.movies)) {
        setRestoreMsg(
          "No se pudo leer el Sheet. Actualiza el script de Apps Script con el endpoint de lectura."
        );
        setRestoringFromSheet(false);
        return;
      }
      const { merged, updatedCount, newCount } = mergeSheetIntoMovies(movies, pullData.movies);

      setMovies(merged);
      setResult(null);
      setPair(null);
      setRestoreMsg(
        `Listo: ${updatedCount} actualizadas, ${newCount} películas nuevas agregadas desde el Sheet.`
      );
    } catch (e) {
      setRestoreMsg("Hubo un error leyendo el Sheet. Intenta de nuevo.");
    }
    setRestoringFromSheet(false);
  };

  const resyncHistoryToSheet = async () => {
    if (!syncUrl || !movies) return;
    setResyncingHistory(true);
    setResyncMsg("");
    try {
      const res = await window.storage.get("cine-elo-rank-history", false);
      if (!res || !res.value) {
        setResyncMsg("No hay historial local guardado.");
        setResyncingHistory(false);
        return;
      }
      const history = JSON.parse(res.value);
      const movieMap = new Map(movies.map((m) => [m.id, m]));
      let sentSnapshots = 0;
      let sentRows = 0;
      for (const snap of history) {
        const entries = snap.ranks
          .map(([id, rank, elo, tmdbId]) => {
            const m = movieMap.get(id);
            if (!m) return null;
            return {
              title: m.title,
              tmdbId: tmdbId || m.tmdbId || "",
              rank,
              elo,
            };
          })
          .filter(Boolean);
        if (entries.length === 0) continue;
        await fetch(syncUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            type: "snapshot",
            timestamp: snap.t,
            entries,
          }),
        });
        sentSnapshots++;
        sentRows += entries.length;
      }
      setResyncMsg(
        `Listo: ${sentSnapshots} corte(s), ${sentRows} filas mandadas al Sheet.`
      );
    } catch (e) {
      setResyncMsg("Hubo un error mandando el historial. Intenta de nuevo.");
    }
    setResyncingHistory(false);
  };

  const saveRankSnapshot = async (moviesList) => {
    const sorted = [...moviesList]
      .sort((a, b) => b.elo - a.elo)
      .slice(0, SNAPSHOT_TOP_N);
    const timestamp = Date.now();
    try {
      const snapshot = {
        t: timestamp,
        ranks: sorted.map((m, idx) => [m.id, idx + 1, m.elo, m.tmdbId || ""]),
      };
      const res = await window.storage.get("cine-elo-rank-history", false);
      let history = [];
      if (res && res.value) {
        try {
          history = JSON.parse(res.value);
        } catch (e) {
          history = [];
        }
      }
      history.push(snapshot);
      if (history.length > MAX_SNAPSHOTS) {
        history = history.slice(history.length - MAX_SNAPSHOTS);
      }
      await window.storage.set(
        "cine-elo-rank-history",
        JSON.stringify(history),
        false
      );
      setRankHistoryCount(history.length);
    } catch (e) {
      // no crítico si falla el guardado local puntual
    }

    // Respaldo en el Google Sheet (hoja HISTORY), best-effort
    if (syncUrl) {
      try {
        const entries = sorted.map((m, idx) => ({
          title: m.title,
          tmdbId: m.tmdbId || "",
          rank: idx + 1,
          elo: m.elo,
        }));
        await fetch(syncUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ type: "snapshot", timestamp, entries }),
        });
      } catch (e) {
        // no crítico si falla el respaldo puntual
      }
    }
  };

  // cargar URL de sync guardada
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(SYNC_URL_KEY, false);
        if (res && res.value) {
          setSyncUrl(res.value);
          setSyncUrlInput(res.value);
        }
      } catch (e) {
        // usa el default
      }
    })();
  }, []);

  const saveSyncUrl = async (url) => {
    setSyncUrl(url);
    try {
      await window.storage.set(SYNC_URL_KEY, url, false);
    } catch (e) {
      // no crítico
    }
  };

  // allowCreate=false (default): un resultado de duelo solo puede
  // ACTUALIZAR filas que ya existen en el Sheet — nunca crear una nueva.
  // Si no lo fuera, una peli borrada del Sheet pero todavía presente en el
  // localStorage de alguien (pestaña vieja sin este fix, cache no
  // refrescado) podía "resucitar" sola en cuanto le tocaba un duelo. Solo
  // el alta explícita de una película nueva (addMovie / bulkSyncAll) pasa
  // allowCreate=true.
  const syncToSheet = useCallback(
    async (items, allowCreate = false) => {
      if (!syncUrl) return;
      setSyncStatus("syncing");
      try {
        const payload = items.map((m) => {
          const item = {
            title: m.title,
            year: m.year || "",
            elo: m.elo,
            games: m.comparisons,
            wins: m.wins,
            losses: m.comparisons - m.wins,
            ties: 0,
          };
          META_FIELDS.forEach(({ key }) => {
            item[key] = m[key] || "";
          });
          return item;
        });
        const url = allowCreate
          ? `${syncUrl}?allowCreate=1`
          : syncUrl;
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(payload),
        });
        setSyncStatus("ok");
      } catch (e) {
        setSyncStatus("error");
      }
    },
    [syncUrl]
  );

  // load
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORAGE_KEY, false);
        if (res && res.value) {
          const saved = JSON.parse(res.value);
          // Migración: completar tmdbId/poster/director/genre en partidas
          // guardadas antes de que existieran esos campos, matcheando por título.
          const seedByTitle = new Map(
            SEED_MOVIES.map((s) => [s[0], s])
          );
          const migrated = saved.map((m) => {
            // Guardas viejas (de antes del fix en el backend) pueden tener
            // títulos numéricos (ej. "2046", "300") guardados como number en
            // vez de string — cualquier .toLowerCase() sobre eso rompe la
            // app entera. Se corrige acá una vez, para todas las pelis.
            const title = String(m.title);
            const seedEntry = seedByTitle.get(title);
            const hasRating = m.rating !== undefined;
            const hasPlays = m.plays !== undefined;
            if (
              typeof m.title === "string" &&
              m.tmdbId &&
              m.poster !== undefined &&
              m.director !== undefined &&
              hasRating &&
              hasPlays
            ) {
              return m;
            }
            if (!seedEntry) {
              return {
                ...m,
                title,
                rating: hasRating ? m.rating : null,
                plays: hasPlays ? m.plays : null,
              };
            }
            const [, , sRating, sPlays, sDirector, sGenre, sPoster, sTmdbId] = seedEntry;
            return {
              ...m,
              title,
              director: m.director || sDirector || "",
              genre: m.genre || sGenre || "",
              poster: m.poster || sPoster || "",
              tmdbId: m.tmdbId || sTmdbId || "",
              rating: hasRating ? m.rating : sRating,
              plays: hasPlays ? m.plays : sPlays,
            };
          });

          // Mostramos lo local YA — no bloqueamos la pantalla de carga
          // esperando al Sheet (con ~5300 pelis el pull completo pesa varios
          // MB y puede tardar más de 10s; antes se esperaba sin timeout y la
          // app se quedaba en "cargando" para siempre si esa espera colgaba).
          setMovies(migrated);

          // Sincronizamos con el Sheet en segundo plano, sin bloquear nada —
          // si no, un dispositivo/navegador que ya tenía algo guardado
          // localmente se queda pegado con esos valores viejos para siempre,
          // aunque el Sheet (la fuente real) haya cambiado desde otro lado.
          fetch(`${DEFAULT_SYNC_URL}?action=pull`)
            .then((r) => r.json())
            .then((pullData) => {
              if (pullData && pullData.ok && Array.isArray(pullData.movies)) {
                setMovies((current) => {
                  const { merged } = mergeSheetIntoMovies(
                    current || migrated,
                    pullData.movies
                  );
                  return merged;
                });
              }
            })
            .catch(() => {
              // sin conexión o el pull tardó/falló: seguimos con lo local.
            });
        } else {
          // Navegador sin progreso local: antes de arrancar de cero, intentamos
          // traer el progreso real desde el Sheet, para no pisarlo con valores
          // en blanco en el próximo sync.
          let sheetProgress = new Map();
          try {
            const pullRes = await fetch(
              `${DEFAULT_SYNC_URL}?action=pull`
            );
            const pullData = await pullRes.json();
            if (pullData && pullData.ok && Array.isArray(pullData.movies)) {
              pullData.movies.forEach((m) => sheetProgress.set(m.title, m));
            }
          } catch (e) {
            // sin conexión o el script todavía no tiene el endpoint nuevo:
            // seguimos con valores iniciales del catálogo, como antes.
          }

          const seeded = SEED_MOVIES.map(([title, year, rating, plays, director, genre, poster, tmdbId]) => {
            const existing = sheetProgress.get(title);
            // El catálogo baked-in (SEED_MOVIES) solo trae estos 4 campos —
            // el resto de META_FIELDS no tiene fallback ahí, solo en el Sheet.
            const seedFallback = { director, genre, poster, tmdbId };
            const movie = {
              id: uid(),
              title,
              year,
              rating: existing && existing.rating != null ? existing.rating : rating,
              plays: existing && existing.plays != null ? existing.plays : plays,
              elo:
                existing && existing.elo != null
                  ? existing.elo
                  : computeInitialElo(rating, plays),
              comparisons: existing ? existing.games || 0 : 0,
              wins: existing ? existing.wins || 0 : 0,
            };
            // Preferimos la metadata del Sheet sobre la del catálogo baked-in:
            // correcciones hechas ahí deben verse sin depender de un reset
            // completo del progreso local.
            META_FIELDS.forEach(({ key, numeric }) => {
              movie[key] = (existing && existing[key]) || seedFallback[key] || (numeric ? null : "");
            });
            return movie;
          });

          // Películas que existen en el Sheet pero no en el catálogo base
          // (agregadas a mano directo en el Sheet, o desde otro dispositivo)
          const seedTitles = new Set(SEED_MOVIES.map((s) => s[0]));
          const extras = [];
          sheetProgress.forEach((sm, title) => {
            if (seedTitles.has(title)) return;
            const movie = {
              id: uid(),
              title,
              year: sm.year || undefined,
              rating: sm.rating,
              plays: sm.plays,
              elo:
                sm.elo != null
                  ? sm.elo
                  : computeInitialElo(sm.rating, sm.plays),
              comparisons: sm.games || 0,
              wins: sm.wins || 0,
            };
            META_FIELDS.forEach(({ key, numeric }) => {
              movie[key] = sm[key] || (numeric ? null : "");
            });
            extras.push(movie);
          });

          setMovies([...seeded, ...extras]);
        }
      } catch (e) {
        setMovies([]);
      }
    })();
  }, []);

  // persist
  useEffect(() => {
    if (movies === null) return;
    (async () => {
      try {
        await window.storage.set(STORAGE_KEY, JSON.stringify(movies), false);
      } catch (e) {
        // ignore transient storage errors
      }
    })();
  }, [movies]);

  const weightedPick = (list, excludeIds, anchorElo) => {
    const candidates = excludeIds
      ? list.filter((m) => !excludeIds.includes(m.id))
      : list;
    if (candidates.length === 0) return null;
    const weights = candidates.map((m) => {
      // Pocos duelos pesa mucho más que muchos duelos.
      const freqWeight = 1 / (1 + m.comparisons);
      // Si hay un ancla de elo, favorece rivales de nivel parecido:
      // matches más parejos son más informativos y convergen más rápido.
      let proxWeight = 1;
      if (anchorElo != null) {
        const diff = Math.abs(m.elo - anchorElo);
        proxWeight = 1 / (1 + diff / 150);
      }
      return freqWeight * proxWeight;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  };

  // Para "ganador se mantiene" / "perdedor se mantiene": elegir rival solo
  // entre los de elo más parecido a la película que se mantiene. Si se
  // usara weightedPick a secas, el peso por "pocos duelos" (que casi todas
  // las pelis comparten al ppio) hace que la MASA total de candidatos
  // lejanos en elo gane por cantidad, aunque cada rival cercano pese más
  // individualmente — terminaba peleando contra cualquier cosa sin duelos,
  // sin importar el nivel.
  const pickNearbyChallenger = (list, excludeIds, anchorElo) => {
    const candidates = list.filter((m) => !excludeIds.includes(m.id));
    if (candidates.length === 0) return null;
    const withDiff = candidates
      .map((m) => ({ m, diff: Math.abs(m.elo - anchorElo) }))
      .sort((a, b) => a.diff - b.diff);
    const windowSize = Math.max(8, Math.ceil(candidates.length * 0.02));
    const nearby = withDiff.slice(0, windowSize);
    // Dentro de la ventana, pesar por qué tan cerca está en elo — NO por
    // cuántos duelos tiene. Si se pesara por duelos acá, "0 duelos" vuelve
    // a ganarle a la cercanía real, que es exactamente lo que queríamos evitar.
    const weights = nearby.map((x) => 1 / (1 + x.diff));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < nearby.length; i++) {
      r -= weights[i];
      if (r <= 0) return nearby[i].m;
    }
    return nearby[nearby.length - 1].m;
  };

  const pickContenders = useCallback((list, size, keepId) => {
    if (!list || list.length < 2) {
      setPair(null);
      return;
    }
    const n = Math.min(size, list.length);
    const champion = keepId ? list.find((m) => m.id === keepId) : null;
    const chosen = champion ? [champion] : [weightedPick(list, [], null)];
    while (chosen.length < n) {
      const anchorElo =
        chosen.reduce((s, m) => s + m.elo, 0) / chosen.length;
      const next = champion
        ? pickNearbyChallenger(list, chosen.map((m) => m.id), anchorElo)
        : weightedPick(list, chosen.map((m) => m.id), anchorElo);
      if (!next) break;
      chosen.push(next);
    }
    // mezclar para que la primera elegida no quede siempre primera en pantalla
    for (let i = chosen.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
    }
    setPair(chosen);
    setRankingPicks([]);
  }, []);

  const directorDuelActive = Boolean(directorDuelA && directorDuelB);

  const pickDirectorDuelPair = useCallback(() => {
    if (!movies) {
      setPair(null);
      return;
    }
    const poolA = movies.filter(
      (m) => m.director === directorDuelA && Number(m.rating) !== 0
    );
    const poolB = movies.filter(
      (m) => m.director === directorDuelB && Number(m.rating) !== 0
    );
    if (poolA.length === 0 || poolB.length === 0) {
      setPair(null);
      return;
    }
    const a = weightedPick(poolA, [], null);
    const b = weightedPick(poolB, [], null);
    if (!a || !b) {
      setPair(null);
      return;
    }
    setPair(Math.random() < 0.5 ? [a, b] : [b, a]);
    setRankingPicks([]);
  }, [movies, directorDuelA, directorDuelB]);

  const ranking = useMemo(() => {
    if (!movies) return [];
    return [...movies].sort((a, b) => b.elo - a.elo);
  }, [movies]);

  // Solo pelis vistas (rating != 0) — las de watchlist quedan con el elo
  // inicial congelado para siempre (nunca entran a un duelo), así que se
  // amontonan al final de "ranking" y arruinan "Peores N" si se usa esa
  // lista completa para calcular el rango.
  const ratedRanking = useMemo(
    () => ranking.filter((m) => Number(m.rating) !== 0),
    [ranking]
  );

  // Rating proyectado: el Elo NO es continuo — se amontona en valores
  // redondos (la mayoría de las pelis tuvo pocos duelos y sigue pegada a su
  // semilla inicial de computeInitialElo). Si le aplicáramos un z-score
  // directo, esos bloques pegoteados generan picos artificiales en el
  // histograma en vez de una campana lisa.
  //
  // En cambio, ubicamos cada Elo por su PERCENTIL real dentro de todo el
  // catálogo puntuado (ranking ordenado, no valor crudo) y pasamos ese
  // percentil por la inversa de la normal (probit). Como el percentil de
  // cualquier distribución es uniforme por construcción, el resultado es
  // una campana genuinamente normal sin importar cómo esté agrupado el Elo
  // de origen — y como el rating real también es 0.5-5, escalamos el ancho
  // de esa campana al desvío real de tus ratings.
  const eloRatingStats = useMemo(() => {
    if (ratedRanking.length < 2) return null;
    const sortedElos = ratedRanking.map((m) => m.elo).sort((a, b) => a - b);
    const ratings = ratedRanking.map((m) => Number(m.rating));
    const mean = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
    const std = (arr, m) =>
      Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
    const meanRating = mean(ratings);
    const stdRating = std(ratings, meanRating);
    return { sortedElos, meanRating, stdRating };
  }, [ratedRanking]);

  // Escala 1-10 (el doble de la escala real de 0.5-5) solo para mostrar —
  // el rating que se guarda sigue siendo 0.5-5 en todos lados.
  //
  // El centro de la proyección se fuerza a 2.525/5 (=5.05/10) en vez de usar
  // el promedio real de tus ratings — el ancho de la campana parte del real
  // (stdRating), pero se ensancha con PROJECTED_RATING_SPREAD para que
  // proporcionalmente entren más pelis en los extremos (0.1/10.0): con
  // spread=1 casi nada tocaba el piso o el techo (percentil+probit da una
  // normal "de verdad", con colas finas por construcción); en 1.3 la
  // proporción en los extremos se multiplica por ~5.
  const PROJECTED_RATING_TARGET_MEAN = 2.525;
  const PROJECTED_RATING_SPREAD = 1.3;
  const projectedRating = useCallback(
    (elo) => {
      if (!eloRatingStats) return null;
      const { sortedElos, stdRating } = eloRatingStats;
      const n = sortedElos.length;
      // Rango de empate (todas las pelis con ESTE mismo Elo exacto):
      // percentil = el punto medio de ese rango, así todas quedan en el
      // mismo lugar de la campana en vez de una detrás de otra al azar.
      let lo = 0,
        hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedElos[mid] < elo) lo = mid + 1;
        else hi = mid;
      }
      const lowerBound = lo;
      hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedElos[mid] <= elo) lo = mid + 1;
        else hi = mid;
      }
      const upperBound = lo;
      const midRank = (lowerBound + upperBound - 1) / 2;
      const percentile = Math.min(
        Math.max((midRank + 0.5) / n, 1e-6),
        1 - 1e-6
      );
      const z = probit(percentile);
      const raw =
        (PROJECTED_RATING_TARGET_MEAN + z * stdRating * PROJECTED_RATING_SPREAD) * 2;
      const clamped = Math.max(0.1, Math.min(10, raw));
      return Math.round(clamped * 10) / 10;
    },
    [eloRatingStats]
  );

  // Estadísticas de la pestaña Resumen — todo derivado de datos que ya
  // tenemos: rating real vs proyectado, duelos jugados, y (si hay) el
  // historial de snapshots para el cambio de Elo entre el corte más viejo
  // guardado y ahora.
  const summaryStats = useMemo(() => {
    if (!movies || ratedRanking.length === 0) return null;

    const withDiff = ratedRanking
      .filter((m) => m.comparisons >= 10)
      .map((m) => {
        const gold = Number(m.rating) * 2;
        const silver = projectedRating(m.elo);
        if (silver == null) return null;
        return { ...m, gold, silver, diff: gold - silver };
      })
      .filter(Boolean);
    const eloLovesMore = [...withDiff]
      .sort((a, b) => a.diff - b.diff)
      .slice(0, 10);
    const youLoveMore = [...withDiff]
      .sort((a, b) => b.diff - a.diff)
      .slice(0, 10);

    const mostDueled = [...movies]
      .filter((m) => m.comparisons > 0)
      .sort((a, b) => b.comparisons - a.comparisons)
      .slice(0, 10);

    const withEnoughGames = movies
      .filter((m) => m.comparisons >= 10)
      .map((m) => ({ ...m, winRate: m.wins / m.comparisons }));
    const bestStreak = [...withEnoughGames]
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 10);
    const worstStreak = [...withEnoughGames]
      .sort((a, b) => a.winRate - b.winRate)
      .slice(0, 10);

    let eloGainers = [];
    let eloLosers = [];
    if (rankHistoryData && rankHistoryData.length >= 2) {
      const sortedSnaps = [...rankHistoryData].sort((a, b) => a.t - b.t);
      const oldest = sortedSnaps[0];
      const newest = sortedSnaps[sortedSnaps.length - 1];
      const oldEloById = new Map(oldest.ranks.map(([id, , elo]) => [id, elo]));
      const movieById = new Map(movies.map((m) => [m.id, m]));
      const deltas = newest.ranks
        .map(([id, , elo]) => {
          const oldElo = oldEloById.get(id);
          const m = movieById.get(id);
          if (oldElo == null || !m) return null;
          return { ...m, eloDelta: elo - oldElo };
        })
        .filter((x) => x && x.eloDelta !== 0 && x.comparisons >= 10);
      eloGainers = [...deltas]
        .sort((a, b) => b.eloDelta - a.eloDelta)
        .slice(0, 10);
      eloLosers = [...deltas]
        .sort((a, b) => a.eloDelta - b.eloDelta)
        .slice(0, 10);
    }

    const avgElo =
      ratedRanking.reduce((s, m) => s + m.elo, 0) / ratedRanking.length;

    return {
      eloLovesMore,
      youLoveMore,
      mostDueled,
      bestStreak,
      worstStreak,
      eloGainers,
      eloLosers,
      totalRated: ratedRanking.length,
      avgElo,
    };
  }, [movies, ratedRanking, projectedRating, rankHistoryData]);

  const yearBounds = useMemo(() => {
    if (!movies) return [1900, new Date().getFullYear()];
    const years = movies
      .map((m) => m.year)
      .filter((y) => typeof y === "number" && y > 0);
    if (years.length === 0) return [1900, new Date().getFullYear()];
    return [Math.min(...years), Math.max(...years)];
  }, [movies]);

  const decadeBounds = useMemo(() => {
    return [
      Math.floor(yearBounds[0] / 10) * 10,
      Math.floor(yearBounds[1] / 10) * 10,
    ];
  }, [yearBounds]);

  const decadeOptions = useMemo(() => {
    const opts = [];
    for (let d = decadeBounds[0]; d <= decadeBounds[1]; d += 10) {
      opts.push(d);
    }
    return opts;
  }, [decadeBounds]);

  // Inicializar el rango de década una sola vez, cuando ya sabemos los límites reales
  useEffect(() => {
    if (movies && duelYearMin === null && duelYearMax === null) {
      setDuelYearMin(decadeBounds[0]);
      setDuelYearMax(decadeBounds[1]);
    }
  }, [movies, decadeBounds, duelYearMin, duelYearMax]);

  const totalComparisons = useMemo(() => {
    if (!movies) return 0;
    return Math.round(movies.reduce((s, m) => s + m.comparisons, 0) / 2);
  }, [movies]);

  const directorsList = useMemo(() => {
    if (!movies) return [];
    const set = new Set();
    movies.forEach((m) => {
      if (m.director) set.add(m.director);
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [movies]);

  // cargar historial de posiciones al entrar a la pestaña Evolución:
  // preferimos traerlo del Sheet (historial completo, sin tope de 15 cortes),
  // y si falla (sin conexión, script viejo, etc.) usamos el local como respaldo.
  useEffect(() => {
    if (
      (tab !== "evolucion" && tab !== "resumen") ||
      rankHistoryData !== null ||
      !movies
    )
      return;
    (async () => {
      try {
        if (syncUrl) {
          const res = await fetch(`${syncUrl}?action=pullHistory`);
          const data = await res.json();
          if (data && data.ok && Array.isArray(data.snapshots)) {
            const titleToId = new Map(movies.map((m) => [m.title, m.id]));
            const converted = data.snapshots
              .map((snap) => ({
                t: snap.t,
                ranks: snap.entries
                  .map((e) => {
                    const id = titleToId.get(e.title);
                    if (!id) return null;
                    return [id, e.rank, e.elo, e.tmdbId || ""];
                  })
                  .filter(Boolean),
              }))
              .filter((snap) => snap.ranks.length > 0);
            if (converted.length > 0) {
              setRankHistoryData(converted);
              return;
            }
          }
        }
      } catch (e) {
        // sin conexión o script sin el endpoint nuevo: caemos al local
      }
      try {
        const res = await window.storage.get("cine-elo-rank-history", false);
        if (res && res.value) {
          setRankHistoryData(JSON.parse(res.value));
        } else {
          setRankHistoryData([]);
        }
      } catch (e) {
        setRankHistoryData([]);
      }
    })();
  }, [tab, rankHistoryData, movies, syncUrl]);

  const EVO_MAX_MOVIES = 10;
  const EVO_PALETTE = [
    "#F2C14E",
    "#6FCF6F",
    "#EB5757",
    "#56CCF2",
    "#BB6BD9",
    "#F2994A",
    "#27AE60",
    "#2D9CDB",
    "#E85D9F",
    "#9B9B9B",
  ];

  // Por defecto, al entrar a la pestaña, precargar el Top 10 actual.
  // Reacciona tanto al cambio de pestaña como a que el ranking termine de
  // cargar (por si todavía no había datos cuando se entró a la pestaña).
  const evoDefaultAppliedRef = useRef(false);
  useEffect(() => {
    if (
      tab === "evolucion" &&
      !evoDefaultAppliedRef.current &&
      evoSelectedIds.length === 0 &&
      ranking.length > 0
    ) {
      setEvoSelectedIds(ranking.slice(0, 10).map((m) => m.id));
      evoDefaultAppliedRef.current = true;
    }
  }, [tab, ranking, evoSelectedIds]);

  const evoSuggestions = useMemo(() => {
    if (!movies) return [];
    const q = evoQuery.trim().toLowerCase();
    if (!q) return [];
    return movies
      .filter(
        (m) =>
          m.title.toLowerCase().includes(q) && !evoSelectedIds.includes(m.id)
      )
      .slice(0, 8);
  }, [movies, evoQuery, evoSelectedIds]);

  const evoSortedHistory = useMemo(() => {
    if (!rankHistoryData) return [];
    return [...rankHistoryData].sort((a, b) => a.t - b.t);
  }, [rankHistoryData]);

  const evoSnapshotMaps = useMemo(() => {
    return evoSortedHistory.map(
      (snap) => new Map(snap.ranks.map((r) => [r[0], r]))
    );
  }, [evoSortedHistory]);

  const evoXAxis = useMemo(
    () => evoSortedHistory.map((s) => s.t),
    [evoSortedHistory]
  );

  const evoMultiSeries = useMemo(() => {
    if (!movies) return [];
    return evoSelectedIds.map((id, idx) => {
      const m = movies.find((mv) => mv.id === id);
      const rankValues = evoSnapshotMaps.map((map) => {
        const e = map.get(id);
        return e ? e[1] : null;
      });
      const eloValues = evoSnapshotMaps.map((map) => {
        const e = map.get(id);
        return e ? e[2] : null;
      });
      const hasAnyData = rankValues.some((v) => v != null);
      return {
        id,
        title: m ? m.title : "(película eliminada)",
        color: EVO_PALETTE[idx % EVO_PALETTE.length],
        rankValues,
        eloValues,
        hasAnyData,
      };
    });
  }, [movies, evoSelectedIds, evoSnapshotMaps]);

  const evoAnySeriesHasData = evoMultiSeries.some((s) => s.hasAnyData);

  const genresList = useMemo(() => {
    if (!movies) return [];
    const set = new Set();
    movies.forEach((m) => {
      if (m.genre) {
        m.genre
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean)
          .forEach((g) => set.add(g));
      }
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [movies]);

  const countriesList = useMemo(() => {
    if (!movies) return [];
    const set = new Set();
    movies.forEach((m) => {
      if (m.country) {
        m.country
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
          .forEach((c) => set.add(c));
      }
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [movies]);

  const languagesList = useMemo(() => {
    if (!movies) return [];
    const set = new Set();
    movies.forEach((m) => {
      if (m.originalLanguage) set.add(languageLabel(m.originalLanguage));
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [movies]);

  const filteredRanking = useMemo(() => {
    let list = ranking;
    if (rankFilterDirector) {
      list = list.filter((m) => m.director === rankFilterDirector);
    }
    if (rankFilterGenre) {
      list = list.filter(
        (m) =>
          m.genre &&
          m.genre
            .split(",")
            .map((g) => g.trim())
            .includes(rankFilterGenre)
      );
    }
    if (rankFilterDecade !== "all") {
      const d = Number(rankFilterDecade);
      list = list.filter((m) => m.year && Math.floor(m.year / 10) * 10 === d);
    }
    return list;
  }, [ranking, rankFilterDirector, rankFilterGenre, rankFilterDecade]);

  const hasRankFilters =
    rankFilterDirector || rankFilterGenre || rankFilterDecade !== "all";

  const duelPool = useMemo(() => {
    if (!movies) return [];
    // Las pelis con rating 0 (no vistas, solo en watchlist) no compiten.
    let pool = movies.filter((m) => Number(m.rating) !== 0);

    const effectiveMax =
      duelRankMax > 0
        ? Math.min(duelRankMax, ratedRanking.length)
        : ratedRanking.length;
    const effectiveMin = Math.max(1, Math.min(duelRankMin, effectiveMax));
    if (effectiveMin > 1 || effectiveMax < ratedRanking.length) {
      const rangeIds = new Set(
        ratedRanking.slice(effectiveMin - 1, effectiveMax).map((m) => m.id)
      );
      pool = pool.filter((m) => rangeIds.has(m.id));
    }

    if (
      duelYearMin != null &&
      duelYearMax != null &&
      (duelYearMin > decadeBounds[0] || duelYearMax < decadeBounds[1])
    ) {
      pool = pool.filter((m) => {
        if (!m.year) return true;
        const decade = Math.floor(m.year / 10) * 10;
        return decade >= duelYearMin && decade <= duelYearMax;
      });
    }

    if (duelDirector) {
      pool = pool.filter((m) => m.director === duelDirector);
    }
    if (duelGenre) {
      pool = pool.filter(
        (m) =>
          m.genre &&
          m.genre
            .split(",")
            .map((g) => g.trim())
            .includes(duelGenre)
      );
    }
    if (duelCountry) {
      pool = pool.filter(
        (m) =>
          m.country &&
          m.country
            .split(",")
            .map((c) => c.trim())
            .includes(duelCountry)
      );
    }
    if (duelLanguage) {
      pool = pool.filter((m) => languageLabel(m.originalLanguage) === duelLanguage);
    }
    if (maxDuelosFilter != null) {
      pool = pool.filter((m) => m.comparisons <= maxDuelosFilter);
    }
    if (duelGoldMin > 1 || duelGoldMax < 10) {
      pool = pool.filter((m) => {
        const gold = Number(m.rating) * 2;
        return gold >= duelGoldMin && gold <= duelGoldMax;
      });
    }
    if (duelSilverMin > 0 || duelSilverMax < 10) {
      pool = pool.filter((m) => {
        const silver = projectedRating(m.elo);
        return silver != null && silver >= duelSilverMin && silver <= duelSilverMax;
      });
    }
    return pool;
  }, [
    movies,
    ratedRanking,
    duelRankMin,
    duelRankMax,
    duelYearMin,
    duelYearMax,
    decadeBounds,
    duelDirector,
    duelCountry,
    duelLanguage,
    maxDuelosFilter,
    duelGenre,
    duelGoldMin,
    duelGoldMax,
    duelSilverMin,
    duelSilverMax,
    projectedRating,
  ]);

  // "Sobrevalorados"/"infravalorados": modo continuo (como duelo de
  // directores) que enfrenta pelis dentro de un pool restringido a las
  // mayores diferencias entre tu rating dorado y el proyectado plateado —
  // mismo cálculo que la pestaña Resumen (gold - silver), pero sobre el
  // duelPool actual (respeta los filtros activos) y exige >=5 duelos
  // jugados para que la diferencia sea confiable.
  const biasedPool = useMemo(() => {
    if (!biasedMode) return [];
    const withDiff = duelPool
      .filter((m) => m.comparisons >= 5)
      .map((m) => {
        const gold = Number(m.rating) * 2;
        const silver = projectedRating(m.elo);
        if (silver == null) return null;
        return { ...m, diff: gold - silver };
      })
      .filter(Boolean);
    withDiff.sort((a, b) =>
      biasedMode === "over" ? b.diff - a.diff : a.diff - b.diff
    );
    return withDiff.slice(0, 24);
  }, [biasedMode, duelPool, projectedRating]);

  const pickBiasedPair = useCallback(() => {
    if (!biasedMode || biasedPool.length < 1 || duelPool.length < 2) {
      setPair(null);
      return;
    }
    const anchor = weightedPick(biasedPool, [], null);
    if (!anchor) {
      setPair(null);
      return;
    }
    const n = Math.min(duelSize, duelPool.length);
    const chosen = [anchor];
    while (chosen.length < n) {
      const next = weightedPick(
        duelPool,
        chosen.map((m) => m.id),
        null
      );
      if (!next) break;
      chosen.push(next);
    }
    // mezclar para que la biased no quede siempre primera en pantalla
    for (let i = chosen.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
    }
    setPair(chosen);
    setRankingPicks([]);
  }, [biasedMode, biasedPool, duelPool, duelSize]);

  const toggleBiasedMode = useCallback(
    (mode) => {
      const next = biasedMode === mode ? null : mode;
      setBiasedMode(next);
      setPair(null);
      if (next) {
        setShowDirectorDuel(false);
        setDirectorDuelA("");
        setDirectorDuelB("");
      }
    },
    [biasedMode]
  );

  useEffect(() => {
    if (biasedMode) {
      if (!pair) pickBiasedPair();
      return;
    }
    if (directorDuelActive) {
      if (!pair) pickDirectorDuelPair();
      return;
    }
    if (duelPool && duelPool.length >= 2 && !pair) {
      const keepId = pendingChampionRef.current;
      pendingChampionRef.current = null;
      pickContenders(duelPool, duelSize, keepId);
    }
    if (duelPool && duelPool.length < 2) {
      setPair(null);
    }
  }, [
    duelPool,
    pair,
    pickContenders,
    duelSize,
    directorDuelActive,
    pickDirectorDuelPair,
    biasedMode,
    pickBiasedPair,
  ]);

  const [newTmdbId, setNewTmdbId] = useState("");
  const [tmdbLookupBusy, setTmdbLookupBusy] = useState(false);

  const addMovie = async (e) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    if (movies.some((m) => m.title.toLowerCase() === title.toLowerCase())) {
      setError("Esa peli ya está en la lista.");
      return;
    }
    setError("");

    let tmdbId = newTmdbId.trim();
    let year = null;
    const meta = {};

    if (syncUrl) {
      setTmdbLookupBusy(true);
      try {
        if (!tmdbId) {
          const searchRes = await fetch(
            `${syncUrl}?action=tmdbSearch&query=${encodeURIComponent(title)}`
          );
          const searchData = await searchRes.json();
          if (searchData.ok && searchData.results && searchData.results.length) {
            tmdbId = String(searchData.results[0].tmdbId);
          }
        }
        if (tmdbId) {
          const detailsRes = await fetch(
            `${syncUrl}?action=tmdbDetails&id=${encodeURIComponent(tmdbId)}`
          );
          const detailsData = await detailsRes.json();
          if (detailsData.ok) {
            year = detailsData.year || null;
            META_FIELDS.forEach(({ key, numeric }) => {
              meta[key] = detailsData[key] || (numeric ? null : "");
            });
          }
        }
      } catch (err) {
        // si TMDB falla, seguimos igual con los campos vacíos
      }
      setTmdbLookupBusy(false);
    }

    const newMovie = {
      id: uid(),
      title,
      ...meta,
      tmdbId: tmdbId || "",
      year,
      elo: START_ELO,
      comparisons: 0,
      wins: 0,
    };
    const next = [...movies, newMovie];
    setMovies(next);
    setNewTitle("");
    setNewTmdbId("");
    syncToSheet([newMovie], true);
  };

  const removeMovie = (id) => {
    const movie = movies.find((m) => m.id === id);
    const next = movies.filter((m) => m.id !== id);
    setMovies(next);
    if (pair && pair.some((p) => p.id === id)) {
      setPair(null);
    }
    if (syncUrl && movie) {
      fetch(syncUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ type: "deleteMovie", title: movie.title }),
      }).catch(() => {
        // si falla el borrado remoto, sigue borrada localmente; el próximo
        // pull la vuelve a traer del Sheet, pero eso ya lo verías reflejado.
      });
    }
  };

  // Click durante un duelo: en uno de 2, resuelve directo (la otra queda
  // última sola). En uno de 3/4, cada click agrega a la fila de "mejor a
  // peor" hasta que solo falta una, que se completa sola sin necesitar click.
  const chooseRank = (movieId) => {
    if (!pair || result) return;
    if (rankingPicks.includes(movieId)) return;
    const nextPicks = [...rankingPicks, movieId];
    if (nextPicks.length >= pair.length - 1) {
      const lastId = pair.map((m) => m.id).find((id) => !nextPicks.includes(id));
      resolveDuel(lastId ? [...nextPicks, lastId] : nextPicks);
    } else {
      setRankingPicks(nextPicks);
    }
  };

  // orderedIds: de mejor a peor. Resuelve cada par (i mejor que j) como una
  // comparación 1 a 1 independiente — un duelo de 4 son 6 pares — y suma
  // los deltas de elo de cada película sobre todos los pares en que participó.
  const resolveDuel = (orderedIds) => {
    if (!pair) return;
    const ordered = orderedIds
      .map((id) => pair.find((m) => m.id === id))
      .filter(Boolean);
    if (ordered.length < 2) return;
    const winner = ordered[0];
    const loser = ordered[ordered.length - 1];

    // Si "ganador se mantiene" o "perdedor se mantiene" está activo, el
    // próximo duelo arranca con esa misma película en vez de armarse desde
    // cero (son excluyentes entre sí, ver toggleWinnerStays/toggleLoserStays).
    pendingChampionRef.current = winnerStaysMode
      ? winner.id
      : loserStaysMode
      ? loser.id
      : null;

    // Guardamos el estado previo para poder deshacer este duelo.
    const prevMovies = movies;
    const affectedIds = ordered.map((m) => m.id);

    const eloRunning = new Map(ordered.map((m) => [m.id, m.elo]));
    const comparisonsRunning = new Map(ordered.map((m) => [m.id, m.comparisons]));
    const totalDelta = new Map(ordered.map((m) => [m.id, 0]));
    const winsAdded = new Map(ordered.map((m) => [m.id, 0]));
    const gamesAdded = new Map(ordered.map((m) => [m.id, 0]));

    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i]; // le gana a b en este par
        const b = ordered[j];
        const eloA = eloRunning.get(a.id);
        const eloB = eloRunning.get(b.id);
        const expA = expectedScore(eloA, eloB);
        const expB = expectedScore(eloB, eloA);
        const deltaA = Math.round(getKFactor(comparisonsRunning.get(a.id)) * (1 - expA));
        const deltaB = Math.round(getKFactor(comparisonsRunning.get(b.id)) * (0 - expB));
        eloRunning.set(a.id, eloA + deltaA);
        eloRunning.set(b.id, eloB + deltaB);
        comparisonsRunning.set(a.id, comparisonsRunning.get(a.id) + 1);
        comparisonsRunning.set(b.id, comparisonsRunning.get(b.id) + 1);
        totalDelta.set(a.id, totalDelta.get(a.id) + deltaA);
        totalDelta.set(b.id, totalDelta.get(b.id) + deltaB);
        winsAdded.set(a.id, winsAdded.get(a.id) + 1);
        gamesAdded.set(a.id, gamesAdded.get(a.id) + 1);
        gamesAdded.set(b.id, gamesAdded.get(b.id) + 1);
      }
    }

    const next = movies.map((m) => {
      if (!totalDelta.has(m.id)) return m;
      return {
        ...m,
        elo: m.elo + totalDelta.get(m.id),
        comparisons: m.comparisons + gamesAdded.get(m.id),
        wins: m.wins + winsAdded.get(m.id),
      };
    });

    setMovies(next);
    setLastAction({ prevMovies, affectedIds });

    const updatedContenders = next.filter((m) => affectedIds.includes(m.id));
    syncToSheet(updatedContenders);

    // Contador de duelos + snapshot periódico de posiciones del ranking
    const newDuelCount = duelCount + 1;
    setDuelCount(newDuelCount);
    window.storage
      .set("cine-elo-duel-count", String(newDuelCount), false)
      .catch(() => {});
    if (newDuelCount % SNAPSHOT_INTERVAL === 0) {
      saveRankSnapshot(next);
    }

    if (quickMode) {
      // Modo rápido: sin pantalla de resultado, directo al siguiente duelo
      setPair(null);
      setRankingPicks([]);
      return;
    }

    // Posición en el ranking antes y después del duelo
    const oldSorted = [...movies].sort((x, y) => y.elo - x.elo);
    const newSorted = [...next].sort((x, y) => y.elo - x.elo);

    const ranking = ordered.map((m, idx) => ({
      id: m.id,
      title: m.title,
      poster: m.poster,
      rating: m.rating,
      place: idx + 1,
      oldElo: m.elo,
      newElo: m.elo + totalDelta.get(m.id),
      delta: totalDelta.get(m.id),
      oldRank: oldSorted.findIndex((x) => x.id === m.id) + 1,
      newRank: newSorted.findIndex((x) => x.id === m.id) + 1,
    }));

    setResult({ ranking });
  };

  const undoLastDuel = () => {
    if (!lastAction) return;
    setMovies(lastAction.prevMovies);
    const revertItems = lastAction.prevMovies.filter((m) =>
      lastAction.affectedIds.includes(m.id)
    );
    syncToSheet(revertItems);
    setLastAction(null);
    setResult(null);
    setRankingPicks([]);
    const newDuelCount = Math.max(0, duelCount - 1);
    setDuelCount(newDuelCount);
    window.storage
      .set("cine-elo-duel-count", String(newDuelCount), false)
      .catch(() => {});
  };

  const bulkSyncAll = async () => {
    if (!syncUrl || !movies) return;
    setBulkSyncing(true);
    setBulkSyncProgress(0);
    const CHUNK_SIZE = 100;
    const chunks = [];
    for (let i = 0; i < movies.length; i += CHUNK_SIZE) {
      chunks.push(movies.slice(i, i + CHUNK_SIZE));
    }
    for (let i = 0; i < chunks.length; i++) {
      await syncToSheet(chunks[i]);
      setBulkSyncProgress(
        Math.round(((i + 1) / chunks.length) * movies.length)
      );
    }
    setBulkSyncing(false);
  };

  const exportProgress = () => {
    const header = "title,year,elo,games,wins,losses,ties";
    const rows = movies.map((m) => {
      const losses = m.comparisons - m.wins;
      const safeTitle = `"${m.title.replace(/"/g, '""')}"`;
      return [safeTitle, m.year ?? "", m.elo, m.comparisons, m.wins, losses, 0].join(",");
    });
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cine-elo-progreso.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const nextDuel = () => {
    setResult(null);
    setPair(null);
  };

  // Auto-avanzar al siguiente duelo: 1s por cada rival enfrentado
  // (duelo de N → (N-1) segundos, así que uno de 10 tarda 9s antes de saltar)
  useEffect(() => {
    if (!result) return;
    const durationMs = (result.ranking.length - 1) * 1000;
    const timer = setTimeout(() => {
      nextDuel();
    }, durationMs);
    return () => clearTimeout(timer);
  }, [result]);

  const reloadSeed = () => {
    const seeded = SEED_MOVIES.map(([title, year, rating, plays, director, genre, poster, tmdbId]) => ({
      id: uid(),
      title,
      year,
      director: director || "",
      genre: genre || "",
      poster: poster || "",
      tmdbId: tmdbId || "",
      rating,
      plays,
      elo: computeInitialElo(rating, plays),
      comparisons: 0,
      wins: 0,
    }));
    setMovies(seeded);
    setPair(null);
    setResult(null);
    setLastAction(null);
    setDuelCount(0);
    setRankHistoryCount(0);
    window.storage.set("cine-elo-duel-count", "0", false).catch(() => {});
    window.storage.delete("cine-elo-rank-history", false).catch(() => {});
    setConfirmReset(false);
  };

  const filteredManageList = useMemo(() => {
    if (!movies) return [];
    const q = debouncedFilterText.trim().toLowerCase();
    if (!q) return [];
    return movies.filter((m) => m.title.toLowerCase().includes(q)).slice(0, 200);
  }, [movies, debouncedFilterText]);

  const hasActiveFilters =
    duelDirector ||
    duelGenre ||
    duelCountry ||
    duelLanguage ||
    maxDuelosFilter != null ||
    duelRankMin > 1 ||
    (duelRankMax > 0 && duelRankMax < ratedRanking.length) ||
    (duelYearMin != null && duelYearMin > decadeBounds[0]) ||
    (duelYearMax != null && duelYearMax < decadeBounds[1]) ||
    duelGoldMin > 1 ||
    duelGoldMax < 10 ||
    duelSilverMin > 0 ||
    duelSilverMax < 10;

  const hasActiveModes =
    quickMode ||
    winnerStaysMode ||
    loserStaysMode ||
    directorDuelActive ||
    biasedMode ||
    duelSize !== 2;

  const setDuelRankRange = (min, max) => {
    setDuelRankMin(min);
    setDuelRankMax(max);
    setPair(null);
  };

  const setDuelYearRange = (min, max) => {
    setDuelYearMin(min);
    setDuelYearMax(max);
    setPair(null);
  };

  // Duelear una peli puntual desde Resumen/Ranking: se limpian modos y
  // filtros de Comparar (para garantizar que la peli entre en el pool, sin
  // importar qué filtros hubiera activos) y se la fija como protagonista del
  // próximo duelo — pickContenders arma el resto alrededor de ella.
  const duelSpecificMovie = useCallback(
    (movieId) => {
      setBiasedMode(null);
      setShowDirectorDuel(false);
      setDirectorDuelA("");
      setDirectorDuelB("");
      setDuelDirector("");
      setDuelGenre("");
      setDuelCountry("");
      setDuelLanguage("");
      setMaxDuelosFilter(null);
      setDuelRankMin(1);
      setDuelRankMax(0);
      setDuelYearMin(decadeBounds[0]);
      setDuelYearMax(decadeBounds[1]);
      setDuelGoldMin(1);
      setDuelGoldMax(10);
      setDuelSilverMin(0);
      setDuelSilverMax(10);
      pendingChampionRef.current = movieId;
      setResult(null);
      setPair(null);
      setTab("comparar");
    },
    [decadeBounds]
  );

  if (movies === null) {
    return (
      <div className="app-root">
        <style>{FONT_IMPORT}</style>
        <div className="loading">CARGANDO…</div>
        <StyleSheet />
      </div>
    );
  }

  return (
    <div className="app-root">
      <style>{FONT_IMPORT}</style>
      <StyleSheet />

      <header className="header">
        <Sprockets />
        <div className="header-inner">
          <a className="back-link" href="../index.html">
            ← MovieWorld
          </a>
          <p className="eyebrow">tu cartelera, tu criterio</p>
          <h1 className="title">CINE ELO</h1>
        </div>
        <Sprockets />
      </header>

      <nav className="tabs">
        <button
          className={"tab" + (tab === "comparar" ? " active" : "")}
          onClick={() => setTab("comparar")}
        >
          Comparar
        </button>
        <button
          className={"tab" + (tab === "ranking" ? " active" : "")}
          onClick={() => setTab("ranking")}
        >
          Ranking
        </button>
        <button
          className={"tab" + (tab === "evolucion" ? " active" : "")}
          onClick={() => setTab("evolucion")}
        >
          Evolución
        </button>
        <button
          className={"tab" + (tab === "torneo" ? " active" : "")}
          onClick={() => setTab("torneo")}
        >
          🏆 Torneo
        </button>
        <button
          className={"tab" + (tab === "resumen" ? " active" : "")}
          onClick={() => setTab("resumen")}
        >
          📊 Resumen
        </button>
        <button
          className={"tab" + (tab === "gestionar" ? " active" : "")}
          onClick={() => setTab("gestionar")}
        >
          Mis pelis
        </button>
      </nav>

      <main className="main">
        {tab === "comparar" && (
          <section>
            {movies.length < 2 ? (
              <div className="empty">
                <p className="empty-title">Falta reparto.</p>
                <p className="empty-body">
                  Agrega al menos dos películas en la pestaña "Mis pelis" para
                  empezar a compararlas.
                </p>
                <button className="btn-gold" onClick={() => setTab("gestionar")}>
                  Agregar películas
                </button>
              </div>
            ) : (
              <>
                <div className="top-controls">
                  <button
                    className={
                      "filters-toggle" + (hasActiveModes ? " active" : "")
                    }
                    onClick={() => setShowModes((v) => !v)}
                  >
                    Modos de duelo{hasActiveModes ? " · activos" : ""}{" "}
                    {showModes ? "▲" : "▼"}
                  </button>
                  <button
                    className={
                      "filters-toggle" + (hasActiveFilters ? " active" : "")
                    }
                    onClick={() => setShowFilters((v) => !v)}
                  >
                    Filtros{hasActiveFilters ? " · activos" : ""}{" "}
                    {showFilters ? "▲" : "▼"}
                  </button>
                  <button
                    className="undo-toggle"
                    onClick={undoLastDuel}
                    disabled={!lastAction}
                    title="Deshacer último duelo"
                  >
                    ↺
                  </button>
                </div>

                {showModes && (
                  <div className="filters-panel">
                    <div className="filter-range-presets">
                      <button
                        className={
                          "quick-toggle" + (quickMode ? " active" : "")
                        }
                        onClick={toggleQuickMode}
                      >
                        ⚡ Modo rápido{quickMode ? " · ON" : ""}
                      </button>
                      <button
                        className={
                          "quick-toggle" + (winnerStaysMode ? " active" : "")
                        }
                        onClick={toggleWinnerStays}
                        title="El ganador se queda a enfrentar rivales nuevos"
                      >
                        👑 Ganador se mantiene{winnerStaysMode ? " · ON" : ""}
                      </button>
                      <button
                        className={
                          "quick-toggle" + (loserStaysMode ? " active" : "")
                        }
                        onClick={toggleLoserStays}
                        title="El perdedor se queda a enfrentar rivales nuevos"
                      >
                        💀 Perdedor se mantiene{loserStaysMode ? " · ON" : ""}
                      </button>
                      <button
                        className={
                          "quick-toggle" + (showDirectorDuel ? " active" : "")
                        }
                        onClick={() => {
                          setShowDirectorDuel((v) => !v);
                          if (!showDirectorDuel) {
                            setBiasedMode(null);
                          }
                        }}
                        title="Duelear solo entre las pelis de dos directores"
                      >
                        ⚔️ Duelo de directores
                        {directorDuelActive ? " · ON" : ""}
                      </button>
                      <button
                        className={
                          "quick-toggle" + (biasedMode === "over" ? " active" : "")
                        }
                        onClick={() => toggleBiasedMode("over")}
                        title="Duelos infinitos entre las pelis con mayor diferencia positiva entre tu rating y el proyectado (las que más sobrevaloras)"
                      >
                        📈 Sobrevalorados{biasedMode === "over" ? " · ON" : ""}
                      </button>
                      <button
                        className={
                          "quick-toggle" + (biasedMode === "under" ? " active" : "")
                        }
                        onClick={() => toggleBiasedMode("under")}
                        title="Duelos infinitos entre las pelis con mayor diferencia negativa entre tu rating y el proyectado (las que más infravaloras)"
                      >
                        📉 Infravalorados{biasedMode === "under" ? " · ON" : ""}
                      </button>
                    </div>

                    {biasedMode &&
                      (biasedPool.length < 1 || duelPool.length < 2) && (
                        <p className="form-error">
                          Muy pocas pelis con al menos 5 duelos (y estos
                          filtros) para duelear.
                        </p>
                      )}

                    <label className="filter-label">
                      Tamaño del duelo
                      <div className="filter-range-presets">
                        {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                          <button
                            key={n}
                            className={
                              "preset-btn" + (duelSize === n ? " active" : "")
                            }
                            onClick={() => changeDuelSize(n)}
                          >
                            {n} pelis
                          </button>
                        ))}
                      </div>
                    </label>

                    {showDirectorDuel && (
                      <>
                        <SearchablePicker
                          label="Director A"
                          options={directorsList}
                          value={directorDuelA}
                          onChange={(d) => {
                            setDirectorDuelA(d);
                            setPair(null);
                          }}
                        />
                        <SearchablePicker
                          label="Director B"
                          options={directorsList}
                          value={directorDuelB}
                          onChange={(d) => {
                            setDirectorDuelB(d);
                            setPair(null);
                          }}
                        />
                        {directorDuelA &&
                          directorDuelB &&
                          directorDuelA === directorDuelB && (
                            <p className="form-error">
                              Elige dos directores distintos.
                            </p>
                          )}
                        {(directorDuelA || directorDuelB) && (
                          <button
                            className="skip"
                            onClick={() => {
                              setDirectorDuelA("");
                              setDirectorDuelB("");
                              setPair(null);
                            }}
                          >
                              limpiar duelo de directores
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}

                {showFilters && !directorDuelActive && (
                  <div className="filters-panel">
                    <SearchablePicker
                      label="Director"
                      options={directorsList}
                      value={duelDirector}
                      onChange={(d) => {
                        setDuelDirector(d);
                        setPair(null);
                      }}
                    />

                    <SearchablePicker
                      label="Género"
                      options={genresList}
                      value={duelGenre}
                      onChange={(g) => {
                        setDuelGenre(g);
                        setPair(null);
                      }}
                    />

                    <SearchablePicker
                      label="País"
                      options={countriesList}
                      value={duelCountry}
                      onChange={(c) => {
                        setDuelCountry(c);
                        setPair(null);
                      }}
                    />

                    <SearchablePicker
                      label="Idioma original"
                      options={languagesList}
                      value={duelLanguage}
                      onChange={(l) => {
                        setDuelLanguage(l);
                        setPair(null);
                      }}
                    />

                    <label className="filter-label">
                      Rango del ranking
                      <span className="filter-range-hint">
                        (solo entre las vistas — {ratedRanking.length} pelis)
                      </span>
                      <span className="filter-range-value">
                        #{duelRankMin} —{" "}
                        {duelRankMax > 0 ? `#${duelRankMax}` : `#${ratedRanking.length}`}
                      </span>
                      <DualRangeSlider
                        min={1}
                        max={ratedRanking.length}
                        step={Math.max(1, Math.round(ratedRanking.length / 200))}
                        valueMin={duelRankMin}
                        valueMax={duelRankMax > 0 ? duelRankMax : ratedRanking.length}
                        onChange={(newMin, newMax) =>
                          setDuelRankRange(
                            newMin,
                            newMax >= ratedRanking.length ? 0 : newMax
                          )
                        }
                      />
                      <div className="filter-range-presets">
                        {[10, 100, 250, 500, 1000].map((n) => (
                          <button
                            key={"top" + n}
                            className={
                              "preset-btn" +
                              (duelRankMin === 1 && duelRankMax === n
                                ? " active"
                                : "")
                            }
                            onClick={() => setDuelRankRange(1, n)}
                          >
                            Top {n}
                          </button>
                        ))}
                        {[10, 100, 250, 500, 1000].map((n) => (
                          <button
                            key={"bottom" + n}
                            className={
                              "preset-btn" +
                              (duelRankMin === Math.max(1, ratedRanking.length - n + 1) &&
                              (duelRankMax === 0 || duelRankMax === ratedRanking.length)
                                ? " active"
                                : "")
                            }
                            onClick={() =>
                              setDuelRankRange(
                                Math.max(1, ratedRanking.length - n + 1),
                                0
                              )
                            }
                          >
                            Peores {n}
                          </button>
                        ))}
                        <button
                          className={
                            "preset-btn" +
                            (duelRankMin === 1 && duelRankMax === 0
                              ? " active"
                              : "")
                          }
                          onClick={() => setDuelRankRange(1, 0)}
                        >
                          Todas
                        </button>
                      </div>
                    </label>

                    <label className="filter-label">
                      Rango de rating dorado
                      <span className="filter-range-value">
                        ★ {duelGoldMin} — ★ {duelGoldMax}
                      </span>
                      <DualRangeSlider
                        min={1}
                        max={10}
                        step={1}
                        valueMin={duelGoldMin}
                        valueMax={duelGoldMax}
                        onChange={(newMin, newMax) => {
                          setDuelGoldMin(newMin);
                          setDuelGoldMax(newMax);
                          setPair(null);
                        }}
                      />
                    </label>

                    <label className="filter-label">
                      Rango de rating plateado
                      <span className="filter-range-value">
                        ★ {duelSilverMin} — ★ {duelSilverMax}
                      </span>
                      <DualRangeSlider
                        min={0}
                        max={10}
                        step={1}
                        valueMin={duelSilverMin}
                        valueMax={duelSilverMax}
                        onChange={(newMin, newMax) => {
                          setDuelSilverMin(newMin);
                          setDuelSilverMax(newMax);
                          setPair(null);
                        }}
                      />
                    </label>

                    <label className="filter-label">
                      Década
                      <select
                        className="filter-select"
                        value={
                          duelYearMin === decadeBounds[0] &&
                          duelYearMax === decadeBounds[1]
                            ? "all"
                            : duelYearMin ?? decadeBounds[0]
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "all") {
                            setDuelYearRange(decadeBounds[0], decadeBounds[1]);
                          } else {
                            const d = Number(v);
                            setDuelYearRange(d, d);
                          }
                        }}
                      >
                        <option value="all">Todas las décadas</option>
                        {decadeOptions.map((d) => (
                          <option key={d} value={d}>
                            {d}s
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="filter-label">
                      Máximo de duelos jugados
                      <div className="filter-range-presets">
                        <button
                          className={
                            "preset-btn" +
                            (maxDuelosFilter == null ? " active" : "")
                          }
                          onClick={() => {
                            setMaxDuelosFilter(null);
                            setPair(null);
                          }}
                        >
                          Todas
                        </button>
                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                          <button
                            key={n}
                            className={
                              "preset-btn" +
                              (maxDuelosFilter === n ? " active" : "")
                            }
                            onClick={() => {
                              setMaxDuelosFilter(n);
                              setPair(null);
                            }}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </label>

                    {hasActiveFilters && (
                      <button
                        className="skip"
                        onClick={() => {
                          setDuelDirector("");
                          setDuelGenre("");
                          setDuelCountry("");
                          setDuelLanguage("");
                          setMaxDuelosFilter(null);
                          setDuelRankRange(1, 0);
                          setDuelYearRange(decadeBounds[0], decadeBounds[1]);
                          setDuelGoldMin(1);
                          setDuelGoldMax(10);
                          setDuelSilverMin(0);
                          setDuelSilverMax(10);
                          setPair(null);
                        }}
                      >
                        limpiar filtros
                      </button>
                    )}
                  </div>
                )}

                {duelPool.length < 2 ? (
                  <div className="empty">
                    <p className="empty-title">Muy pocas con estos filtros.</p>
                    <p className="empty-body">
                      Con esta combinación de director, género y rango solo
                      queda {duelPool.length}{" "}
                      {duelPool.length === 1 ? "película" : "películas"}.
                      Ajusta los filtros para seguir comparando.
                    </p>
                  </div>
                ) : result ? (
                  <DuelResult
                    result={result}
                    onNext={nextDuel}
                    projectedRating={projectedRating}
                  />
                ) : pair ? (
                  <div className="duel">
                    <p className="duel-caption">
                      {rankingPicks.length === 0
                        ? "¿cuál es mejor?"
                        : "de las que quedan, ¿cuál es la mejor?"}
                    </p>
                    <div
                      className={
                        "duel-cards duel-cards-" +
                        pair.length +
                        (pair.length > 4 ? " duel-cards-grid" : "")
                      }
                    >
                      {pair.map((m, i) => {
                        const pickIndex = rankingPicks.indexOf(m.id);
                        const picked = pickIndex !== -1;
                        return (
                        <React.Fragment key={m.id}>
                          <button
                            className={
                              "movie-card" + (picked ? " movie-card-picked" : "")
                            }
                            onClick={() => chooseRank(m.id)}
                            disabled={picked}
                          >
                            <div className="poster-wrap">
                              <MoviePoster path={m.poster} title={m.title} />
                              {picked && (
                                <span className="pick-order-badge">
                                  {pickIndex + 1}º
                                </span>
                              )}
                            </div>
                            <div className="movie-card-body">
                              <span className="rank-badge">
                                #{ranking.findIndex((r) => r.id === m.id) + 1}
                              </span>
                              <span className="movie-card-title">
                                {m.title}
                                {m.year ? (
                                  <span className="movie-card-year">
                                    {" "}
                                    ({m.year})
                                  </span>
                                ) : null}
                              </span>
                              {m.director && (
                                <span className="movie-card-director">
                                  {m.director}
                                </span>
                              )}
                              <span className="movie-card-elo">
                                {m.elo}
                                <span className="movie-card-games">
                                  {" "}
                                  · {m.comparisons}{" "}
                                  {m.comparisons === 1 ? "duelo" : "duelos"}
                                </span>
                              </span>
                              <span className="movie-card-ratings">
                                {(() => {
                                  const silver = projectedRating(m.elo);
                                  if (Number(m.rating) > 0 && silver != null) {
                                    const gold = Number(m.rating) * 2;
                                    return (
                                      <RatingDiff
                                        gold={gold}
                                        silver={silver}
                                        diff={gold - silver}
                                      />
                                    );
                                  }
                                  return (
                                    <>
                                      {Number(m.rating) > 0 && (
                                        <span
                                          className="movie-card-rating-gold"
                                          title="Tu rating"
                                        >
                                          ★ {Number(m.rating) * 2}
                                        </span>
                                      )}
                                      {silver != null && (
                                        <span
                                          className="movie-card-rating-silver"
                                          title="Rating proyectado según el Elo"
                                        >
                                          ★ {silver}
                                        </span>
                                      )}
                                    </>
                                  );
                                })()}
                              </span>
                            </div>
                          </button>
                          {i < pair.length - 1 && pair.length <= 4 && (
                            <div className="vs-wrap">
                              <span className="vs">VS</span>
                            </div>
                          )}
                        </React.Fragment>
                        );
                      })}
                    </div>
                    <button
                      className="skip"
                      onClick={() =>
                        directorDuelActive
                          ? pickDirectorDuelPair()
                          : pickContenders(duelPool, duelSize)
                      }
                    >
                      saltear este duelo →
                    </button>
                    <p className="counter">
                      {totalComparisons} comparaciones ·{" "}
                      {directorDuelActive
                        ? `${directorDuelA} vs ${directorDuelB}`
                        : `${duelPool.length} ${
                            hasActiveFilters ? "en este filtro" : "películas"
                          }`}
                    </p>
                  </div>
                ) : (
                  <div className="empty">
                    <p className="empty-title">Preparando el duelo…</p>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {tab === "ranking" && (
          <section>
            {ranking.length === 0 ? (
              <div className="empty">
                <p className="empty-title">Todavía no hay ranking.</p>
                <p className="empty-body">
                  Agrega películas y empieza a compararlas para ver el orden.
                </p>
              </div>
            ) : (
              <>
                <input
                  className="add-input"
                  type="text"
                  placeholder="Buscar en el ranking…"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  style={{ marginBottom: "12px", width: "100%" }}
                />

                <button
                  className={
                    "filters-toggle" + (hasRankFilters ? " active" : "")
                  }
                  onClick={() => setShowRankFilters((v) => !v)}
                  style={{ marginBottom: "12px" }}
                >
                  Filtros{hasRankFilters ? " · activos" : ""}{" "}
                  {showRankFilters ? "▲" : "▼"}
                </button>

                {showRankFilters && (
                  <div className="filters-panel">
                    <SearchablePicker
                      label="Director"
                      options={directorsList}
                      value={rankFilterDirector}
                      onChange={(d) => setRankFilterDirector(d)}
                    />

                    <SearchablePicker
                      label="Género"
                      options={genresList}
                      value={rankFilterGenre}
                      onChange={(g) => setRankFilterGenre(g)}
                    />

                    <label className="filter-label">
                      Década
                      <select
                        className="filter-select"
                        value={rankFilterDecade}
                        onChange={(e) => setRankFilterDecade(e.target.value)}
                      >
                        <option value="all">Todas las décadas</option>
                        {decadeOptions.map((d) => (
                          <option key={d} value={d}>
                            {d}s
                          </option>
                        ))}
                      </select>
                    </label>

                    {hasRankFilters && (
                      <button
                        className="skip"
                        onClick={() => {
                          setRankFilterDirector("");
                          setRankFilterGenre("");
                          setRankFilterDecade("all");
                        }}
                      >
                        limpiar filtros
                      </button>
                    )}
                  </div>
                )}

                {filteredRanking.length === 0 ? (
                  <p className="sync-hint" style={{ textAlign: "center" }}>
                    Ninguna película coincide con estos filtros.
                  </p>
                ) : (
                  <RankingList
                    ranking={filteredRanking}
                    filterText={debouncedFilterText}
                    globalRanking={ranking}
                    projectedRating={projectedRating}
                    onDuel={duelSpecificMovie}
                  />
                )}
              </>
            )}
          </section>
        )}

        {tab === "evolucion" && (
          <section>
            <p className="duel-caption">evolución de posiciones</p>
            <div className="autocomplete" style={{ marginBottom: "10px" }}>
              <input
                className="filter-select"
                type="text"
                placeholder={
                  evoSelectedIds.length >= EVO_MAX_MOVIES
                    ? `Máximo ${EVO_MAX_MOVIES} películas`
                    : "Escribe para agregar una película…"
                }
                value={evoQuery}
                disabled={evoSelectedIds.length >= EVO_MAX_MOVIES}
                onFocus={() => setEvoDropdownOpen(true)}
                onChange={(e) => {
                  setEvoQuery(e.target.value);
                  setEvoDropdownOpen(true);
                }}
                onBlur={() =>
                  setTimeout(() => setEvoDropdownOpen(false), 150)
                }
              />
              {evoDropdownOpen && evoSuggestions.length > 0 && (
                <div className="autocomplete-list">
                  {evoSuggestions.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      className="autocomplete-option"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setEvoSelectedIds((prev) =>
                          prev.length >= EVO_MAX_MOVIES
                            ? prev
                            : [...prev, m.id]
                        );
                        setEvoQuery("");
                        setEvoDropdownOpen(false);
                      }}
                    >
                      {m.title}
                      {m.year ? ` (${m.year})` : ""}
                    </button>
                  ))}
                </div>
              )}
              {evoDropdownOpen &&
                evoQuery.trim() &&
                evoSuggestions.length === 0 && (
                  <div className="autocomplete-list">
                    <span className="autocomplete-empty">Sin resultados</span>
                  </div>
                )}
            </div>

            {evoMultiSeries.length > 0 && (
              <div className="evo-chips">
                {evoMultiSeries.map((s) => (
                  <span
                    key={s.id}
                    className="evo-chip"
                    style={{ borderColor: s.color }}
                  >
                    <span
                      className="evo-chip-dot"
                      style={{ background: s.color }}
                    />
                    {s.title}
                    {!s.hasAnyData && (
                      <span className="evo-chip-warn"> (sin data)</span>
                    )}
                    <button
                      type="button"
                      className="evo-chip-remove"
                      onClick={() =>
                        setEvoSelectedIds((prev) =>
                          prev.filter((id) => id !== s.id)
                        )
                      }
                      aria-label={`Quitar ${s.title}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            {rankHistoryData === null ? (
              <p className="sync-hint" style={{ textAlign: "center" }}>
                Cargando historial…
              </p>
            ) : rankHistoryData.length === 0 ? (
              <div className="empty">
                <p className="empty-title">Todavía no hay historial.</p>
                <p className="empty-body">
                  Se guarda un corte automático cada {SNAPSHOT_INTERVAL}{" "}
                  duelos. Sigue jugando y vuelve más adelante.
                </p>
              </div>
            ) : evoMultiSeries.length === 0 ? (
              <p className="sync-hint" style={{ textAlign: "center" }}>
                Busca una o varias películas arriba para ver y comparar cómo
                cambió su posición en el ranking a lo largo del tiempo.
              </p>
            ) : evoXAxis.length < 2 || !evoAnySeriesHasData ? (
              <div className="empty">
                <p className="empty-title">Todavía no hay suficiente data.</p>
                <p className="empty-body">
                  Necesitas al menos 2 cortes del historial en los que estas
                  películas hayan estado dentro del top {SNAPSHOT_TOP_N}.
                </p>
              </div>
            ) : (
              <>
                <p className="evo-chart-title">Posición en el ranking</p>
                <MultiLineChart
                  xAxis={evoXAxis}
                  series={evoMultiSeries.map((s) => ({
                    ...s,
                    values: s.rankValues,
                  }))}
                  lowerIsBetter
                />

                <p className="evo-chart-title">Elo</p>
                <MultiLineChart
                  xAxis={evoXAxis}
                  series={evoMultiSeries.map((s) => ({
                    ...s,
                    values: s.eloValues,
                  }))}
                />
              </>
            )}
          </section>
        )}

        {tab === "torneo" && (
          <section>
            {!tournament ? (
              <div className="empty">
                <p className="empty-title">Arma un torneo</p>
                <p className="empty-body">
                  Elige cuántas películas entran (al azar entre las vistas,
                  opcionalmente filtradas) y arrancamos un cuadro de
                  eliminación directa.
                </p>

                <div
                  className="filters-panel"
                  style={{ marginTop: "16px", justifyContent: "center" }}
                >
                  <SearchablePicker
                    label="Género"
                    options={genresList}
                    value={tournamentFilterGenre}
                    onChange={setTournamentFilterGenre}
                  />

                  <label className="filter-label">
                    Década
                    <select
                      className="filter-select"
                      value={tournamentFilterDecade}
                      onChange={(e) => setTournamentFilterDecade(e.target.value)}
                    >
                      <option value="all">Todas las décadas</option>
                      {decadeOptions.map((d) => (
                        <option key={d} value={d}>
                          {d}s
                        </option>
                      ))}
                    </select>
                  </label>

                  <SearchablePicker
                    label="País"
                    options={countriesList}
                    value={tournamentFilterCountry}
                    onChange={setTournamentFilterCountry}
                  />

                  <SearchablePicker
                    label="Idioma original"
                    options={languagesList}
                    value={tournamentFilterLanguage}
                    onChange={setTournamentFilterLanguage}
                  />

                  {(tournamentFilterGenre ||
                    tournamentFilterCountry ||
                    tournamentFilterLanguage ||
                    tournamentFilterDecade !== "all") && (
                    <button
                      className="skip"
                      onClick={() => {
                        setTournamentFilterGenre("");
                        setTournamentFilterDecade("all");
                        setTournamentFilterCountry("");
                        setTournamentFilterLanguage("");
                      }}
                    >
                      limpiar filtros
                    </button>
                  )}
                </div>

                <div
                  className="filter-range-presets"
                  style={{ justifyContent: "center", marginTop: "16px" }}
                >
                  {[8, 16, 32].map((n) => (
                    <button
                      key={n}
                      className="preset-btn"
                      onClick={() => startTournament(n)}
                    >
                      {n} pelis
                    </button>
                  ))}
                </div>
                {error && <p className="form-error">{error}</p>}
              </div>
            ) : tournament.champion ? (
              (() => {
                const champ = movies.find((m) => m.id === tournament.champion);
                return (
                  <div className="empty">
                    <p className="empty-title">🏆 Campeón del torneo</p>
                    {champ && (
                      <>
                        <div
                          style={{
                            width: "160px",
                            margin: "16px auto",
                          }}
                        >
                          <MoviePoster path={champ.poster} title={champ.title} />
                        </div>
                        <p
                          className="empty-body"
                          style={{
                            fontSize: "18px",
                            fontWeight: 700,
                            color: "#EDEAE3",
                          }}
                        >
                          {champ.title}
                          {champ.year ? ` (${champ.year})` : ""}
                        </p>
                        <p className="empty-body">{champ.director}</p>
                      </>
                    )}
                    <button className="btn-gold" onClick={resetTournament}>
                      Nuevo torneo
                    </button>
                  </div>
                );
              })()
            ) : (
              <>
                {(() => {
                  const current = findCurrentTournamentMatch(tournament);
                  if (!current) return null;
                  const a = movies.find((m) => m.id === current.match.a);
                  const b = movies.find((m) => m.id === current.match.b);
                  if (!a || !b) return null;
                  const playersInRound =
                    tournament.rounds[current.roundIdx].length * 2;
                  return (
                    <div className="duel">
                      <p className="duel-caption">
                        {tournamentRoundName(playersInRound)}
                      </p>
                      <div className="duel-cards duel-cards-2">
                        {[a, b].map((m, i) => (
                          <React.Fragment key={m.id}>
                            <button
                              className="movie-card"
                              onClick={() => chooseTournamentWinner(m.id)}
                            >
                              <div className="poster-wrap">
                                <MoviePoster path={m.poster} title={m.title} />
                              </div>
                              <div className="movie-card-body">
                                <span className="rank-badge">
                                  #{ranking.findIndex((r) => r.id === m.id) + 1}
                                </span>
                                <span className="movie-card-title">
                                  {m.title}
                                  {m.year ? (
                                    <span className="movie-card-year">
                                      {" "}
                                      ({m.year})
                                    </span>
                                  ) : null}
                                </span>
                                {m.director && (
                                  <span className="movie-card-director">
                                    {m.director}
                                  </span>
                                )}
                                <span className="movie-card-elo">
                                  {m.elo}
                                </span>
                              </div>
                            </button>
                            {i === 0 && (
                              <div className="vs-wrap">
                                <span className="vs">VS</span>
                              </div>
                            )}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                <button
                  className="skip"
                  onClick={resetTournament}
                  style={{ marginTop: "16px" }}
                >
                  cancelar torneo
                </button>

                <div className="tournament-bracket">
                  {tournament.rounds.map((round, ri) => (
                    <div key={ri} className="tournament-round">
                      <p className="tournament-round-title">
                        {tournamentRoundName(round.length * 2)}
                      </p>
                      {round.map((m, mi) => {
                        const aM = movies.find((x) => x.id === m.a);
                        const bM = movies.find((x) => x.id === m.b);
                        const winM = movies.find((x) => x.id === m.winner);
                        return (
                          <p key={mi} className="tournament-match-line">
                            {aM ? aM.title : "?"} vs {bM ? bM.title : "?"}
                            {winM ? ` → ${winM.title}` : ""}
                          </p>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {tab === "resumen" && (
          <section>
            {!summaryStats ? (
              <div className="empty">
                <p className="empty-title">Todavía no hay nada que resumir.</p>
                <p className="empty-body">
                  Puntúa y duelea algunas películas primero.
                </p>
              </div>
            ) : (
              <div className="summary-grid">
                <div className="summary-card">
                  <p className="summary-card-title">📉 Infravaloradas</p>
                  <p className="summary-card-sub">
                    el Elo dice que las quieres más de lo que las puntuaste (mín. 10 duelos)
                  </p>
                  <SummaryList
                    onDuel={duelSpecificMovie}
                    items={summaryStats.eloLovesMore}
                    render={(m) => <RatingDiff gold={m.gold} silver={m.silver} diff={m.diff} />}
                  />
                </div>

                <div className="summary-card">
                  <p className="summary-card-title">📈 Sobrevaloradas</p>
                  <p className="summary-card-sub">
                    les pusiste más nota de la que el Elo cree que merecen (mín. 10 duelos)
                  </p>
                  <SummaryList
                    onDuel={duelSpecificMovie}
                    items={summaryStats.youLoveMore}
                    render={(m) => <RatingDiff gold={m.gold} silver={m.silver} diff={m.diff} />}
                  />
                </div>

                {summaryStats.eloGainers.length > 0 && (
                  <div className="summary-card">
                    <p className="summary-card-title">Más subieron de Elo</p>
                    <p className="summary-card-sub">
                      desde el corte más viejo guardado (mín. 10 duelos)
                    </p>
                    <SummaryList
                      onDuel={duelSpecificMovie}
                      items={summaryStats.eloGainers}
                      render={(m) => `+${m.eloDelta}`}
                    />
                  </div>
                )}

                {summaryStats.eloLosers.length > 0 && (
                  <div className="summary-card">
                    <p className="summary-card-title">Más bajaron de Elo</p>
                    <p className="summary-card-sub">
                      desde el corte más viejo guardado (mín. 10 duelos)
                    </p>
                    <SummaryList
                      onDuel={duelSpecificMovie}
                      items={summaryStats.eloLosers}
                      render={(m) => `${m.eloDelta}`}
                    />
                  </div>
                )}

                <div className="summary-card">
                  <p className="summary-card-title">Las más dueleadas</p>
                  <p className="summary-card-sub">las que más veces entraron a un duelo</p>
                  <SummaryList
                    onDuel={duelSpecificMovie}
                    items={summaryStats.mostDueled}
                    render={(m) => `${m.comparisons} duelos`}
                  />
                </div>

                <div className="summary-card">
                  <p className="summary-card-title">Mejor racha</p>
                  <p className="summary-card-sub">mayor % de duelos ganados (mín. 10 duelos)</p>
                  <SummaryList
                    onDuel={duelSpecificMovie}
                    items={summaryStats.bestStreak}
                    render={(m) => `${Math.round(m.winRate * 100)}%`}
                  />
                </div>

                <div className="summary-card">
                  <p className="summary-card-title">Peor racha</p>
                  <p className="summary-card-sub">menor % de duelos ganados (mín. 10 duelos)</p>
                  <SummaryList
                    onDuel={duelSpecificMovie}
                    items={summaryStats.worstStreak}
                    render={(m) => `${Math.round(m.winRate * 100)}%`}
                  />
                </div>

                <div className="summary-card">
                  <p className="summary-card-title">En números</p>
                  <div className="summary-kpis">
                    <div className="summary-kpi">
                      <span className="summary-kpi-value">
                        {summaryStats.totalRated}
                      </span>
                      <span className="summary-kpi-label">puntuadas</span>
                    </div>
                    <div className="summary-kpi">
                      <span className="summary-kpi-value">
                        {Math.round(summaryStats.avgElo)}
                      </span>
                      <span className="summary-kpi-label">elo promedio</span>
                    </div>
                    <div className="summary-kpi">
                      <span className="summary-kpi-value">{duelCount}</span>
                      <span className="summary-kpi-label">duelos jugados</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "gestionar" && (
          <section>
            <form className="add-form" onSubmit={addMovie}>
              <div className="add-form-fields">
                <input
                  className="add-input"
                  type="text"
                  placeholder="Título de la película"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
                <input
                  className="add-input add-input-id"
                  type="text"
                  inputMode="numeric"
                  placeholder="ID de TMDB (opcional)"
                  value={newTmdbId}
                  onChange={(e) => setNewTmdbId(e.target.value)}
                />
              </div>
              <button className="btn-gold" type="submit" disabled={tmdbLookupBusy}>
                {tmdbLookupBusy ? "Buscando…" : "Agregar"}
              </button>
            </form>
            {error && <p className="form-error">{error}</p>}

            <p className="counter" style={{ margin: "4px 0 12px" }}>
              {movies.length} películas en tu catálogo
            </p>

            <input
              className="add-input"
              type="text"
              placeholder="Buscar en tu lista…"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{ marginBottom: "12px", width: "100%" }}
            />

            {movies.length === 0 ? (
              <div className="empty">
                <p className="empty-title">Lista vacía.</p>
                <p className="empty-body">Suma tu primera película arriba.</p>
              </div>
            ) : !filterText.trim() ? (
              <p className="sync-hint" style={{ textAlign: "center" }}>
                Escribe algo arriba para buscar y editar una película puntual.
              </p>
            ) : (
              <>
                <ul className="manage-list">
                  {filteredManageList.map((m) => (
                    <li key={m.id} className="manage-row">
                      <span className="manage-title">
                        {m.title}
                        {m.year ? ` (${m.year})` : ""}
                      </span>
                      <span className="manage-elo">{m.elo}</span>
                      <button
                        className="remove-btn"
                        onClick={() => removeMovie(m.id)}
                        aria-label={`Quitar ${m.title}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                {filteredManageList.length === 0 && (
                  <p className="sync-hint" style={{ textAlign: "center" }}>
                    Sin resultados para "{filterText}".
                  </p>
                )}
                {filteredManageList.length === 200 && (
                  <p className="counter" style={{ marginTop: "10px" }}>
                    mostrando los primeros 200 resultados
                  </p>
                )}
              </>
            )}

            <div style={{ marginTop: "28px", textAlign: "center" }}>
              <button className="skip" onClick={exportProgress}>
                exportar mi progreso (CSV)
              </button>
            </div>

            <div className="sync-panel">
              <p className="sync-title">
                Sincronización con Google Sheets
                {syncStatus === "ok" && (
                  <span className="sync-badge sync-ok">● conectado</span>
                )}
                {syncStatus === "syncing" && (
                  <span className="sync-badge sync-pending">● enviando…</span>
                )}
                {syncStatus === "error" && (
                  <span className="sync-badge sync-error">● error</span>
                )}
              </p>
              <input
                className="add-input"
                type="text"
                placeholder="URL del webhook de Apps Script"
                value={syncUrlInput}
                onChange={(e) => setSyncUrlInput(e.target.value)}
                style={{ width: "100%", marginBottom: "8px" }}
              />
              <button
                className="skip"
                onClick={() => saveSyncUrl(syncUrlInput.trim())}
              >
                guardar URL
              </button>{" "}
              <button
                className="skip"
                onClick={bulkSyncAll}
                disabled={bulkSyncing || !syncUrl}
              >
                {bulkSyncing
                  ? `sincronizando… ${bulkSyncProgress}/${movies.length}`
                  : "sincronizar todo mi progreso ahora"}
              </button>{" "}
              <button
                className="skip"
                onClick={restoreFromSheet}
                disabled={restoringFromSheet || !syncUrl}
              >
                {restoringFromSheet
                  ? "restaurando…"
                  : "restaurar mi progreso desde el Sheet"}
              </button>
              {restoreMsg && (
                <p className="sync-hint" style={{ margin: "6px 0 0" }}>
                  {restoreMsg}
                </p>
              )}
              <p className="sync-hint">
                <strong>"Sincronizar todo"</strong> manda lo que tienes en{" "}
                <em>este</em> navegador hacia el Sheet (pisa el Sheet).{" "}
                <strong>"Restaurar"</strong> hace lo contrario: trae lo que
                hay en el Sheet hacia este navegador (pisa lo local). Usa
                "restaurar" siempre que abras la app en un dispositivo nuevo
                o si algo quedó desincronizado.
              </p>
            </div>

            <div className="sync-panel">
              <p className="sync-title">Historial de posiciones</p>
              <p className="sync-hint" style={{ margin: 0 }}>
                Duelos jugados: {duelCount} · Cortes guardados:{" "}
                {rankHistoryCount}/{MAX_SNAPSHOTS}
                <br />
                Cada {SNAPSHOT_INTERVAL} duelos se guarda automáticamente la
                posición, elo e ID de TMDB del top {SNAPSHOT_TOP_N}, tanto
                local como en la hoja "HISTORY" de tu Google Sheet (respaldo).
              </p>
              <button
                className="skip"
                onClick={resyncHistoryToSheet}
                disabled={resyncingHistory || !syncUrl}
                style={{ marginTop: "10px" }}
              >
                {resyncingHistory
                  ? "mandando historial…"
                  : "reenviar historial local al Sheet"}
              </button>
              {resyncMsg && (
                <p className="sync-hint" style={{ margin: "6px 0 0" }}>
                  {resyncMsg}
                </p>
              )}
            </div>

            <div style={{ marginTop: "10px", textAlign: "center" }}>
              {confirmReset ? (
                <>
                  <p className="empty-body" style={{ marginBottom: "10px" }}>
                    Esto borra tu progreso y vuelve a cargar el catálogo completo
                    de tu excel ({SEED_MOVIES.length} películas). ¿Confirmas?
                  </p>
                  <button className="btn-gold" onClick={reloadSeed}>
                    Sí, reiniciar catálogo
                  </button>{" "}
                  <button className="skip" onClick={() => setConfirmReset(false)}>
                    cancelar
                  </button>
                </>
              ) : (
                <button className="skip" onClick={() => setConfirmReset(true)}>
                  reiniciar con el catálogo completo del excel
                </button>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function DualRangeSlider({ min, max, valueMin, valueMax, step, onChange }) {
  const span = max - min || 1;
  const pctMin = ((valueMin - min) / span) * 100;
  const pctMax = ((valueMax - min) / span) * 100;

  return (
    <div className="dual-range">
      <div className="dual-range-track" />
      <div
        className="dual-range-fill"
        style={{
          left: `${pctMin}%`,
          width: `${Math.max(0, pctMax - pctMin)}%`,
        }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step || 1}
        value={valueMin}
        onChange={(e) => {
          const v = Math.min(Number(e.target.value), valueMax);
          onChange(v, valueMax);
        }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step || 1}
        value={valueMax}
        onChange={(e) => {
          const v = Math.max(Number(e.target.value), valueMin);
          onChange(valueMin, v);
        }}
      />
    </div>
  );
}

// Combobox genérico: escribís para filtrar una lista larga (directores,
// géneros, países, idiomas...) en vez de scrollear un <select> gigante.
function SearchablePicker({ label, options, value, onChange, placeholder }) {
  const [query, setQuery] = useState(value || "");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setQuery(value || "");
  }, [value]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? options.filter((d) => d.toLowerCase().includes(q))
      : options;
    return base.slice(0, 8);
  }, [options, query]);

  return (
    <label className="filter-label">
      {label}
      <div className="autocomplete">
        <input
          className="filter-select"
          type="text"
          placeholder={placeholder || "Escribe para buscar…"}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            if (e.target.value.trim() === "") onChange("");
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {value && (
          <button
            type="button"
            className="autocomplete-clear"
            onMouseDown={(e) => {
              e.preventDefault();
              onChange("");
              setQuery("");
            }}
            aria-label="Limpiar"
          >
            ×
          </button>
        )}
        {open && suggestions.length > 0 && (
          <div className="autocomplete-list">
            {suggestions.map((d) => (
              <button
                type="button"
                key={d}
                className="autocomplete-option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(d);
                  setQuery(d);
                  setOpen(false);
                }}
              >
                {d}
              </button>
            ))}
          </div>
        )}
        {open && query.trim() && suggestions.length === 0 && (
          <div className="autocomplete-list">
            <span className="autocomplete-empty">Sin resultados</span>
          </div>
        )}
      </div>
    </label>
  );
}

function MoviePoster({ path, title }) {
  const [failed, setFailed] = useState(false);

  if (!path || failed) {
    return (
      <div className="poster-fallback">
        <span className="poster-fallback-icon">🎬</span>
      </div>
    );
  }

  const src = path.startsWith("/")
    ? `${TMDB_POSTER_BASE}${path}`
    : `${TMDB_POSTER_BASE}/${path}`;

  return (
    <img
      className="movie-poster"
      src={src}
      alt={`Póster de ${title}`}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function DuelResult({ result, onNext, projectedRating }) {
  const { ranking } = result;
  const n = ranking.length;
  const rivals = n - 1;

  // El hint de abajo describe por qué la GANADORA sumó lo que sumó — así que
  // tiene que basarse en su Elo viejo contra el de las rivales que venció,
  // no en la magnitud de lo que sumó. Esa magnitud también depende del
  // K-factor (32/20/12 según cuántos duelos jugó cada una, ver getKFactor),
  // así que una peli nueva puede sumar "mucho" sin haber vencido a nadie
  // mejor puntuada, y el texto quedaba contradiciendo lo que mostraban las
  // fichas de arriba (#rank viejo → nuevo, Elo viejo → nuevo).
  const winner = ranking[0];
  const beatenRivals = ranking.slice(1);
  const toughestRivalElo = beatenRivals.length
    ? Math.max(...beatenRivals.map((r) => r.oldElo))
    : winner.oldElo;
  const eloGapVsToughest = toughestRivalElo - winner.oldElo;

  const placeLabel = (place) => {
    if (place === 1) return "ganó";
    if (place === n) return "perdió";
    return `${place}º lugar`;
  };
  const placeClass = (place) => {
    if (place === 1) return "result-winner";
    if (place === n) return "result-loser";
    return "result-middle";
  };

  return (
    <div className="duel-result">
      <p className="duel-caption">resultado</p>

      {ranking.map((r) => {
        const oldProj = projectedRating ? projectedRating(r.oldElo) : null;
        const newProj = projectedRating ? projectedRating(r.newElo) : null;
        const projDelta =
          oldProj != null && newProj != null
            ? Math.round((newProj - oldProj) * 10) / 10
            : null;
        return (
          <div className={"result-card " + placeClass(r.place)} key={r.id}>
            <div className="result-poster">
              <MoviePoster path={r.poster} title={r.title} />
            </div>
            <div className="result-body">
              <div className="result-heading">
                <span className="result-badge">{placeLabel(r.place)}</span>
                <span className="result-title">{r.title}</span>
              </div>

              <span className="result-rank-row">
                #{r.oldRank} → #{r.newRank}
                {r.newRank < r.oldRank && (
                  <span className="result-rank-change up">
                    ↑ {r.oldRank - r.newRank}
                  </span>
                )}
                {r.newRank > r.oldRank && (
                  <span className="result-rank-change down">
                    ↓ {r.newRank - r.oldRank}
                  </span>
                )}
              </span>

              <div className="result-stats-row">
                <span className="result-elo-row">
                  {r.oldElo}
                  <span className="result-arrow">→</span>
                  {r.newElo}
                  <span
                    className={
                      "result-delta " +
                      (r.delta >= 0 ? "result-delta-up" : "result-delta-down")
                    }
                  >
                    {r.delta >= 0 ? "+" : ""}
                    {r.delta}
                  </span>
                </span>
                {Number(r.rating) > 0 && (
                  <span className="movie-card-rating movie-card-rating-gold">
                    ★ {Number(r.rating) * 2}
                  </span>
                )}
              </div>

              {newProj != null && (
                <span className="result-rating-change-row">
                  ★ {oldProj}
                  <span className="result-arrow">→</span>
                  ★ {newProj}
                  {projDelta != null && projDelta !== 0 && (
                    <span
                      className={
                        "result-delta " +
                        (projDelta > 0 ? "result-delta-up" : "result-delta-down")
                      }
                    >
                      {projDelta > 0 ? "+" : ""}
                      {projDelta}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        );
      })}

      <p className="result-hint">
        {eloGapVsToughest <= 0
          ? "Ya era la mejor puntuada del grupo: por eso sumó poco."
          : eloGapVsToughest >= 100
          ? "Le ganó a alguien bastante mejor puntuado: por eso sumó tanto."
          : "Diferencia moderada de nivel entre las opciones."}
      </p>

      <div className="auto-advance-bar">
        <div
          className="auto-advance-fill"
          style={{ animationDuration: `${rivals}s` }}
        />
      </div>
    </div>
  );
}

function MultiLineChart({ xAxis, series, lowerIsBetter }) {
  const svgRef = useRef(null);
  const [hoverIdx, setHoverIdx] = useState(null);
  const n = xAxis.length;
  if (n < 2) return null;

  const W = 300;
  const H = 140;
  const PAD = 16;

  const allValues = series.flatMap((s) => s.values.filter((v) => v != null));
  if (allValues.length === 0) return null;
  let minV = Math.min(...allValues);
  let maxV = Math.max(...allValues);
  if (minV === maxV) {
    minV -= 1;
    maxV += 1;
  }

  const stepX = n > 1 ? (W - PAD * 2) / (n - 1) : 0;
  const scaleY = (v) => {
    const t = (v - minV) / (maxV - minV);
    const norm = lowerIsBetter ? t : 1 - t;
    return norm * (H - PAD * 2) + PAD;
  };

  const buildPath = (values) => {
    let d = "";
    let started = false;
    values.forEach((v, i) => {
      if (v == null) {
        started = false;
        return;
      }
      const x = PAD + i * stepX;
      const y = scaleY(v);
      d += `${started ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)} `;
      started = true;
    });
    return d;
  };

  const updateHoverFromClientX = (clientX) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = (clientX - rect.left) / rect.width;
    const idx = Math.round(relX * (n - 1));
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  };

  return (
    <div className="evo-chart-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="evo-chart-svg"
        preserveAspectRatio="none"
        onMouseMove={(e) => updateHoverFromClientX(e.clientX)}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchStart={(e) => updateHoverFromClientX(e.touches[0].clientX)}
        onTouchMove={(e) => updateHoverFromClientX(e.touches[0].clientX)}
        onTouchEnd={() => setHoverIdx(null)}
      >
        {series.map((s) => (
          <path
            key={s.id}
            d={buildPath(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
          />
        ))}
        {series.map((s) =>
          s.values.map((v, i) =>
            v == null ? null : (
              <circle
                key={s.id + "-" + i}
                cx={PAD + i * stepX}
                cy={scaleY(v)}
                r="2.2"
                fill={s.color}
              />
            )
          )
        )}
        {hoverIdx != null && (
          <line
            x1={PAD + hoverIdx * stepX}
            x2={PAD + hoverIdx * stepX}
            y1={PAD}
            y2={H - PAD}
            stroke="#8A8D98"
            strokeWidth="1"
            strokeDasharray="3,3"
          />
        )}
      </svg>

      {hoverIdx != null ? (
        <div className="evo-tooltip">
          <div className="evo-tooltip-date">
            {new Date(xAxis[hoverIdx]).toLocaleDateString("es-CL", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
          {series.map((s) => (
            <div className="evo-tooltip-row" key={s.id}>
              <span
                className="evo-tooltip-dot"
                style={{ background: s.color }}
              />
              <span className="evo-tooltip-title">{s.title}</span>
              <span className="evo-tooltip-value">
                {s.values[hoverIdx] == null
                  ? "—"
                  : lowerIsBetter
                  ? `#${s.values[hoverIdx]}`
                  : s.values[hoverIdx]}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="evo-chart-hint">toca o pasa el mouse para ver el detalle</p>
      )}
    </div>
  );
}

function SummaryList({ items, render, onDuel }) {
  if (items.length === 0) {
    return <p className="summary-empty">No hay suficientes datos todavía.</p>;
  }
  return (
    <ol className="summary-list">
      {items.map((m) => (
        <li key={m.id} className="summary-row">
          <div className="summary-poster">
            <MoviePoster path={m.poster} title={m.title} />
          </div>
          <button
            type="button"
            className="summary-row-title"
            onClick={() => onDuel(m.id)}
            title="Duelear esta película"
          >
            {m.title}
          </button>
          <a
            className="summary-row-edit"
            href={`edit.html?title=${encodeURIComponent(m.title)}`}
            target="_blank"
            rel="noreferrer"
            title="Editar esta película"
          >
            ✏️
          </a>
          <span className="summary-row-value">{render(m)}</span>
        </li>
      ))}
    </ol>
  );
}

function RatingDiff({ gold, silver, diff }) {
  const rounded = Math.round(diff * 10) / 10;
  return (
    <>
      <span className="movie-card-rating-gold">★ {gold}</span>
      <span className="result-arrow">→</span>
      <span className="movie-card-rating-silver">★ {silver}</span>
      <span
        className={
          "result-delta " + (rounded >= 0 ? "result-delta-up" : "result-delta-down")
        }
      >
        {rounded >= 0 ? "+" : ""}
        {rounded}
      </span>
    </>
  );
}

function RankingList({ ranking, filterText, globalRanking, projectedRating, onDuel }) {
  const source = globalRanking || ranking;
  const q = filterText.trim().toLowerCase();
  const filtered = q
    ? ranking.filter((m) => m.title.toLowerCase().includes(q))
    : ranking;
  const visible = filtered.slice(0, 200);
  return (
    <>
      <ol className="ranking-list" start={q ? undefined : 1}>
        {visible.map((m) => {
          const idx = source.indexOf(m);
          const proj = projectedRating ? projectedRating(m.elo) : null;
          return (
            <li key={m.id} className="rank-row">
              <span className="rank-num">{idx + 1}</span>
              <div className="rank-poster">
                <MoviePoster path={m.poster} title={m.title} />
              </div>
              <div className="rank-info">
                <span className="rank-title-row">
                  <button
                    type="button"
                    className="rank-title"
                    onClick={() => onDuel(m.id)}
                    title="Duelear esta película"
                  >
                    {m.title}
                    {m.year ? <span className="rank-year"> ({m.year})</span> : null}
                  </button>
                  <a
                    className="rank-edit"
                    href={`edit.html?title=${encodeURIComponent(m.title)}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Editar esta película"
                  >
                    ✏️
                  </a>
                </span>
                <span className="rank-meta">
                  {m.comparisons} comparaciones · {m.wins} ganadas
                  {m.plays ? ` · vista ${m.plays}x` : ""}
                </span>
                <span className="movie-card-ratings">
                  {Number(m.rating) > 0 && (
                    <span className="movie-card-rating movie-card-rating-gold">
                      ★ {Number(m.rating) * 2}
                    </span>
                  )}
                  {proj != null && (
                    <span className="movie-card-rating movie-card-rating-silver">
                      ★ {proj}
                    </span>
                  )}
                </span>
              </div>
              <span className="rank-elo">{m.elo}</span>
            </li>
          );
        })}
      </ol>
      {filtered.length > 200 && (
        <p className="counter" style={{ marginTop: "10px" }}>
          mostrando 200 de {filtered.length} resultados
        </p>
      )}
    </>
  );
}

function StyleSheet() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      .app-root {
        min-height: 100vh;
        background: radial-gradient(ellipse at top, #1c1e26 0%, #101116 60%);
        color: #EDEAE3;
        font-family: 'Archivo', sans-serif;
        display: flex;
        flex-direction: column;
        padding-bottom: 32px;
      }
      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        font-family: 'Space Mono', monospace;
        color: #8A8D98;
        letter-spacing: 0.2em;
      }
      .sprockets {
        display: flex;
        justify-content: space-evenly;
        padding: 6px 10px;
        background: #0B0C10;
      }
      .hole {
        width: 8px;
        height: 8px;
        border-radius: 2px;
        background: #F2C14E;
        opacity: 0.85;
      }
      .header-inner {
        text-align: center;
        padding: 18px 16px 14px;
        background: #0B0C10;
        border-bottom: 1px solid rgba(242,193,78,0.15);
      }
      .back-link {
        display: inline-block;
        color: #8A8D98;
        text-decoration: none;
        font-size: 12px;
        margin-bottom: 8px;
      }
      .back-link:hover {
        color: #F2C14E;
      }
      .eyebrow {
        font-family: 'Space Mono', monospace;
        font-size: 11px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #C0392B;
        margin: 0 0 4px;
      }
      .title {
        font-family: 'Bebas Neue', sans-serif;
        font-size: 44px;
        letter-spacing: 0.06em;
        margin: 0;
        color: #F2C14E;
        line-height: 1;
        text-shadow: 0 0 18px rgba(242,193,78,0.25);
      }
      .tabs {
        display: flex;
        gap: 6px;
        padding: 14px 16px 0;
        overflow-x: auto;
      }
      .tab {
        flex: 1 0 auto;
        min-width: 76px;
        background: #1A1C24;
        border: 1px solid rgba(242,193,78,0.12);
        color: #8A8D98;
        font-family: 'Archivo', sans-serif;
        font-weight: 600;
        font-size: 12px;
        padding: 10px 6px;
        border-radius: 8px 8px 0 0;
        cursor: pointer;
        white-space: nowrap;
      }
      .tab.active {
        color: #F2C14E;
        background: #22242E;
        border-bottom: 2px solid #F2C14E;
      }
      .main {
        flex: 1;
        padding: 22px 16px 8px;
        max-width: 480px;
        width: 100%;
        margin: 0 auto;
      }
      .empty {
        text-align: center;
        padding: 40px 16px;
        border: 1px dashed rgba(242,193,78,0.25);
        border-radius: 12px;
      }
      .empty-title {
        font-family: 'Bebas Neue', sans-serif;
        font-size: 24px;
        color: #F2C14E;
        margin: 0 0 8px;
        letter-spacing: 0.03em;
      }
      .empty-body {
        color: #8A8D98;
        font-size: 14px;
        margin: 0 0 16px;
        line-height: 1.5;
      }
      .btn-gold {
        background: #F2C14E;
        color: #14151A;
        border: none;
        font-weight: 700;
        font-size: 14px;
        padding: 12px 20px;
        border-radius: 8px;
        cursor: pointer;
      }
      .duel-caption {
        text-align: center;
        font-family: 'Space Mono', monospace;
        font-size: 12px;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        color: #8A8D98;
        margin: 0 0 16px;
      }
      .top-controls {
        display: flex;
        gap: 8px;
        margin-bottom: 14px;
      }
      .filters-toggle {
        display: block;
        flex: 1;
        background: #1A1C24;
        border: 1px solid rgba(242,193,78,0.15);
        color: #8A8D98;
        font-family: 'Archivo', sans-serif;
        font-size: 13px;
        font-weight: 600;
        padding: 10px 14px;
        border-radius: 8px;
        cursor: pointer;
      }
      .filters-toggle.active {
        color: #F2C14E;
        border-color: rgba(242,193,78,0.4);
      }
      .quick-toggle {
        display: block;
        flex: 1;
        background: #1A1C24;
        border: 1px solid rgba(242,193,78,0.15);
        color: #8A8D98;
        font-family: 'Archivo', sans-serif;
        font-size: 13px;
        font-weight: 600;
        padding: 10px 14px;
        border-radius: 8px;
        cursor: pointer;
      }
      .quick-toggle.active {
        color: #14151A;
        background: #F2C14E;
        border-color: #F2C14E;
      }
      .undo-toggle {
        flex-shrink: 0;
        background: #1A1C24;
        border: 1px solid rgba(242,193,78,0.15);
        color: #EDEAE3;
        font-size: 16px;
        padding: 10px 14px;
        border-radius: 8px;
        cursor: pointer;
      }
      .undo-toggle:disabled {
        color: #55575F;
        cursor: default;
        opacity: 0.5;
      }
      .filters-panel {
        background: #1A1C24;
        border: 1px solid rgba(242,193,78,0.12);
        border-radius: 10px;
        padding: 14px;
        margin-bottom: 16px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .filter-label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-family: 'Space Mono', monospace;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #8A8D98;
      }
      .filter-checkbox {
        flex-direction: row;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      .filter-checkbox input {
        width: 15px;
        height: 15px;
        accent-color: #F2C14E;
        cursor: pointer;
      }
      .filter-select {
        background: #22242E;
        border: 1px solid rgba(242,193,78,0.2);
        border-radius: 8px;
        padding: 9px 10px;
        color: #EDEAE3;
        font-family: 'Archivo', sans-serif;
        font-size: 13px;
        text-transform: none;
        letter-spacing: normal;
        width: 100%;
      }
      .autocomplete {
        position: relative;
      }
      .autocomplete .filter-select {
        padding-right: 30px;
      }
      .autocomplete-clear {
        position: absolute;
        right: 6px;
        top: 50%;
        transform: translateY(-50%);
        background: none;
        border: none;
        color: #C0392B;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        padding: 4px 6px;
      }
      .autocomplete-list {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        background: #22242E;
        border: 1px solid rgba(242,193,78,0.25);
        border-radius: 8px;
        max-height: 220px;
        overflow-y: auto;
        z-index: 20;
        box-shadow: 0 8px 20px rgba(0,0,0,0.4);
      }
      .autocomplete-option {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        color: #EDEAE3;
        font-family: 'Archivo', sans-serif;
        font-size: 13px;
        text-transform: none;
        letter-spacing: normal;
        padding: 10px 12px;
        cursor: pointer;
      }
      .autocomplete-option:hover {
        background: rgba(242,193,78,0.12);
      }
      .autocomplete-empty {
        display: block;
        padding: 10px 12px;
        color: #8A8D98;
        font-size: 12px;
        font-family: 'Space Mono', monospace;
      }
      .filter-range-value {
        color: #F2C14E;
        font-weight: 700;
      }
      .filter-range-hint {
        display: block;
        color: #55575F;
        font-size: 10px;
        font-family: 'Space Mono', monospace;
        text-transform: none;
        letter-spacing: normal;
        margin-top: 2px;
      }
      .dual-range {
        position: relative;
        height: 28px;
        margin: 8px 0 2px;
      }
      .dual-range-track {
        position: absolute;
        top: 50%;
        left: 0;
        right: 0;
        height: 4px;
        background: rgba(242,193,78,0.15);
        border-radius: 999px;
        transform: translateY(-50%);
      }
      .dual-range-fill {
        position: absolute;
        top: 50%;
        height: 4px;
        background: #F2C14E;
        border-radius: 999px;
        transform: translateY(-50%);
      }
      .dual-range input[type="range"] {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 28px;
        margin: 0;
        background: transparent;
        pointer-events: none;
        -webkit-appearance: none;
        appearance: none;
      }
      .dual-range input[type="range"]::-webkit-slider-runnable-track {
        background: transparent;
      }
      .dual-range input[type="range"]::-moz-range-track {
        background: transparent;
      }
      .dual-range input[type="range"]::-webkit-slider-thumb {
        pointer-events: auto;
        -webkit-appearance: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #F2C14E;
        border: 2px solid #14151A;
        cursor: pointer;
        margin-top: 6px;
      }
      .dual-range input[type="range"]::-moz-range-thumb {
        pointer-events: auto;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #F2C14E;
        border: 2px solid #14151A;
        cursor: pointer;
      }
      .filter-range {
        width: 100%;
        accent-color: #F2C14E;
      }
      .filter-range-presets {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .preset-btn {
        background: #22242E;
        border: 1px solid rgba(242,193,78,0.2);
        color: #8A8D98;
        font-family: 'Space Mono', monospace;
        font-size: 11px;
        padding: 6px 10px;
        border-radius: 999px;
        cursor: pointer;
      }
      .preset-btn.active {
        color: #14151A;
        background: #F2C14E;
        border-color: #F2C14E;
      }
      .duel-cards {
        display: flex;
        flex-direction: column;
        gap: 0;
        align-items: stretch;
      }
      .duel-cards-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .movie-card {
        background: #1E2027;
        border: 1px solid rgba(242,193,78,0.18);
        border-radius: 12px;
        padding: 12px;
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 14px;
        cursor: pointer;
        transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
        color: #EDEAE3;
        text-align: left;
        overflow: hidden;
      }
      .movie-card:active {
        transform: scale(0.97);
      }
      .movie-card-picked {
        opacity: 0.45;
        cursor: default;
        border-color: rgba(242,193,78,0.4);
      }
      .movie-card-picked:active {
        transform: none;
      }
      .pick-order-badge {
        position: absolute;
        top: 6px;
        left: 6px;
        background: #F2C14E;
        color: #14151A;
        font-family: 'Space Mono', monospace;
        font-weight: 700;
        font-size: 12px;
        padding: 2px 7px;
        border-radius: 999px;
      }
      .poster-wrap {
        position: relative;
        flex-shrink: 0;
        width: 76px;
        height: 114px;
        border-radius: 8px;
        overflow: hidden;
        background: #14151A;
      }
      .movie-poster {
        width: 76px;
        height: 114px;
        object-fit: cover;
        display: block;
      }
      .poster-fallback {
        width: 76px;
        height: 114px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(160deg, #22242E, #14151A);
      }
      .poster-fallback-icon {
        font-size: 26px;
        opacity: 0.4;
      }
      .movie-card-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        flex: 1;
      }
      .rank-badge {
        font-family: 'Space Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.1em;
        color: #C0392B;
        background: rgba(192,57,43,0.12);
        border: 1px solid rgba(192,57,43,0.35);
        padding: 2px 8px;
        border-radius: 999px;
        align-self: flex-start;
      }
      .movie-card-title {
        font-family: 'Bebas Neue', sans-serif;
        font-size: 20px;
        letter-spacing: 0.02em;
        line-height: 1.15;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .movie-card-year, .rank-year {
        font-family: 'Space Mono', monospace;
        font-size: 0.55em;
        color: #8A8D98;
        letter-spacing: 0;
      }
      .movie-card-director {
        font-family: 'Archivo', sans-serif;
        font-size: 11px;
        font-style: italic;
        color: #8A8D98;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .movie-card-elo {
        font-family: 'Space Mono', monospace;
        font-size: 12px;
        color: #8A8D98;
        position: relative;
      }
      .movie-card-games {
        color: #55575F;
      }
      .movie-card-ratings {
        display: flex;
        gap: 10px;
        font-family: 'Space Mono', monospace;
        font-size: 11px;
      }
      .movie-card-rating-gold {
        color: #F2C14E;
      }
      .movie-card-rating-silver {
        color: #B8BCC6;
      }
      .delta {
        color: #F2C14E;
        margin-left: 6px;
        font-weight: 700;
      }
      .vs-wrap {
        display: flex;
        justify-content: center;
        margin: -14px 0;
        z-index: 1;
      }
      .vs {
        background: #C0392B;
        color: #EDEAE3;
        font-family: 'Bebas Neue', sans-serif;
        font-size: 15px;
        letter-spacing: 0.1em;
        padding: 6px 14px;
        border-radius: 999px;
        border: 3px solid #101116;
      }
      .skip {
        display: block;
        margin: 18px auto 6px;
        background: none;
        border: none;
        color: #8A8D98;
        font-size: 13px;
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .duel-result {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .result-card {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 14px;
        border-radius: 12px;
        border: 1px solid rgba(242,193,78,0.15);
        background: #1A1C24;
        text-align: left;
      }
      .result-winner {
        border-color: rgba(242,193,78,0.4);
        background: #262A1E;
      }
      .result-loser {
        opacity: 0.7;
      }
      .result-middle {
        opacity: 0.85;
      }
      .result-poster {
        flex: 0 0 56px;
        width: 56px;
        height: 84px;
        border-radius: 8px;
        overflow: hidden;
        background: #14151A;
      }
      .result-poster .movie-poster,
      .result-poster .poster-fallback {
        width: 56px;
        height: 84px;
      }
      .result-poster .poster-fallback-icon {
        font-size: 18px;
      }
      .result-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        flex: 1;
      }
      .result-heading {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .result-badge {
        font-family: 'Space Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #8A8D98;
        flex: 0 0 auto;
      }
      .result-winner .result-badge {
        color: #F2C14E;
      }
      .result-title {
        font-family: 'Bebas Neue', sans-serif;
        font-size: 18px;
        letter-spacing: 0.02em;
        line-height: 1.15;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .result-stats-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }
      .result-elo-row {
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: 'Space Mono', monospace;
        font-size: 11px;
        color: #8A8D98;
      }
      .result-rating-change-row {
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: 'Space Mono', monospace;
        font-size: 11px;
        color: #B8BCC6;
      }
      .result-arrow {
        color: #55575F;
      }
      .result-delta {
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 999px;
        font-size: 10px;
      }
      .result-delta-up {
        color: #14151A;
        background: #F2C14E;
      }
      .result-delta-down {
        color: #EDEAE3;
        background: rgba(192,57,43,0.5);
      }
      .result-rank-row {
        font-family: 'Space Mono', monospace;
        font-size: 15px;
        font-weight: 700;
        color: #EDEAE3;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .result-rank-change {
        font-size: 11px;
        font-weight: 700;
      }
      .result-rank-change.up {
        color: #F2C14E;
      }
      .result-rank-change.down {
        color: #C0392B;
      }
      .result-hint {
        text-align: center;
        font-size: 12px;
        color: #8A8D98;
        margin: 2px 0 6px;
      }
      .auto-advance-bar {
        width: 100%;
        height: 3px;
        background: rgba(242,193,78,0.12);
        border-radius: 999px;
        margin-top: 10px;
        overflow: hidden;
      }
      .auto-advance-fill {
        height: 100%;
        background: #F2C14E;
        width: 0%;
        animation: fillBar 1s linear forwards;
      }
      @keyframes fillBar {
        from { width: 0%; }
        to { width: 100%; }
      }
      .counter {
        text-align: center;
        font-family: 'Space Mono', monospace;
        font-size: 11px;
        color: #55575F;
        margin-top: 10px;
      }
      .tournament-bracket {
        margin-top: 24px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .tournament-round-title {
        font-family: 'Space Mono', monospace;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #F2C14E;
        margin: 0 0 6px;
      }
      .tournament-match-line {
        font-size: 13px;
        color: #8A8D98;
        margin: 0 0 4px;
      }
      .ranking-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .rank-row {
        display: flex;
        align-items: center;
        gap: 12px;
        background: #1A1C24;
        border: 1px solid rgba(242,193,78,0.1);
        border-radius: 10px;
        padding: 8px 14px 8px 8px;
      }
      .rank-poster {
        flex-shrink: 0;
        width: 40px;
        height: 60px;
        border-radius: 5px;
        overflow: hidden;
        background: #14151A;
      }
      .rank-poster .movie-poster,
      .rank-poster .poster-fallback {
        width: 40px;
        height: 60px;
      }
      .rank-poster .poster-fallback-icon {
        font-size: 16px;
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 14px;
      }
      .summary-card {
        background: #1A1C24;
        border: 1px solid rgba(242,193,78,0.15);
        border-radius: 12px;
        padding: 16px;
      }
      .summary-card-title {
        font-family: 'Bebas Neue', sans-serif;
        font-size: 20px;
        letter-spacing: 0.02em;
        color: #EDEAE3;
        margin: 0 0 2px;
      }
      .summary-card-sub {
        font-size: 11px;
        color: #8A8D98;
        margin: 0 0 12px;
      }
      .summary-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .summary-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .summary-poster {
        flex-shrink: 0;
        width: 32px;
        height: 48px;
        border-radius: 4px;
        overflow: hidden;
        background: #14151A;
      }
      .summary-poster .movie-poster,
      .summary-poster .poster-fallback {
        width: 32px;
        height: 48px;
      }
      .summary-poster .poster-fallback-icon {
        font-size: 13px;
      }
      .summary-row-title {
        flex: 1;
        min-width: 0;
        font-size: 13px;
        color: #EDEAE3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-decoration: none;
        background: none;
        border: none;
        padding: 0;
        font-family: inherit;
        text-align: left;
        cursor: pointer;
      }
      .summary-row-title:hover {
        color: #F2C14E;
        text-decoration: underline;
      }
      .summary-row-edit {
        flex-shrink: 0;
        font-size: 12px;
        text-decoration: none;
        opacity: 0.55;
        line-height: 1;
      }
      .summary-row-edit:hover {
        opacity: 1;
      }
      .summary-row-value {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 4px;
        font-family: 'Space Mono', monospace;
        font-size: 12px;
        font-weight: 700;
        color: #F2C14E;
      }
      .summary-empty {
        font-size: 12px;
        color: #8A8D98;
      }
      .summary-kpis {
        display: flex;
        gap: 20px;
      }
      .summary-kpi {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .summary-kpi-value {
        font-family: 'Space Mono', monospace;
        font-size: 22px;
        font-weight: 700;
        color: #EDEAE3;
      }
      .summary-kpi-label {
        font-size: 11px;
        color: #8A8D98;
      }
      .rank-num {
        font-family: 'Bebas Neue', sans-serif;
        font-size: 22px;
        color: #F2C14E;
        width: 28px;
        text-align: center;
        flex-shrink: 0;
      }
      .rank-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .rank-title-row {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .rank-title {
        flex: 1;
        min-width: 0;
        font-family: inherit;
        font-weight: 700;
        font-size: 15px;
        color: #EDEAE3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        background: none;
        border: none;
        padding: 0;
        text-align: left;
        cursor: pointer;
      }
      .rank-title:hover {
        color: #F2C14E;
        text-decoration: underline;
      }
      .rank-edit {
        flex-shrink: 0;
        font-size: 12px;
        text-decoration: none;
        opacity: 0.55;
        line-height: 1;
      }
      .rank-edit:hover {
        opacity: 1;
      }
      .rank-meta {
        font-size: 11px;
        color: #8A8D98;
        font-family: 'Space Mono', monospace;
      }
      .rank-elo {
        font-family: 'Space Mono', monospace;
        font-weight: 700;
        color: #F2C14E;
        font-size: 15px;
        flex-shrink: 0;
      }
      .add-form {
        display: flex;
        gap: 8px;
        margin-bottom: 8px;
        align-items: flex-start;
      }
      .add-form-fields {
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex: 1;
      }
      .add-input {
        flex: 1;
        background: #1A1C24;
        border: 1px solid rgba(242,193,78,0.2);
        border-radius: 8px;
        padding: 12px 14px;
        color: #EDEAE3;
        font-size: 14px;
        font-family: 'Archivo', sans-serif;
      }
      .add-input:focus {
        outline: 2px solid #F2C14E;
        outline-offset: 1px;
      }
      .form-error {
        color: #C0392B;
        font-size: 12px;
        margin: 0 0 10px;
      }
      .sync-panel {
        margin-top: 24px;
        padding: 14px;
        background: #1A1C24;
        border: 1px solid rgba(242,193,78,0.12);
        border-radius: 10px;
        text-align: center;
      }
      .sync-title {
        font-family: 'Space Mono', monospace;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #8A8D98;
        margin: 0 0 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .sync-badge {
        font-size: 10px;
        letter-spacing: 0.05em;
      }
      .sync-ok { color: #6FCF6F; }
      .sync-pending { color: #F2C14E; }
      .sync-error { color: #C0392B; }
      .sync-hint {
        font-size: 11px;
        color: #8A8D98;
        margin: 10px 0 0;
        line-height: 1.4;
      }
      .evo-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 16px;
      }
      .evo-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: #1A1C24;
        border: 1px solid;
        border-radius: 999px;
        padding: 6px 8px 6px 10px;
        font-size: 12px;
        color: #EDEAE3;
      }
      .evo-chip-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .evo-chip-warn {
        color: #8A8D98;
        font-size: 10px;
      }
      .evo-chip-remove {
        background: none;
        border: none;
        color: #8A8D98;
        font-size: 15px;
        line-height: 1;
        cursor: pointer;
        padding: 0 2px;
      }
      .evo-chart-title {
        font-family: 'Space Mono', monospace;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #8A8D98;
        margin: 18px 0 8px;
      }
      .evo-chart-wrap {
        background: #1A1C24;
        border: 1px solid rgba(242,193,78,0.1);
        border-radius: 10px;
        padding: 10px 10px 6px;
      }
      .evo-chart-svg {
        width: 100%;
        height: 140px;
        display: block;
        cursor: crosshair;
        touch-action: none;
      }
      .evo-chart-hint {
        text-align: center;
        font-family: 'Space Mono', monospace;
        font-size: 10px;
        color: #55575F;
        margin: 6px 0 2px;
      }
      .evo-tooltip {
        margin-top: 6px;
        padding: 8px 10px;
        background: #14151A;
        border-radius: 8px;
        border: 1px solid rgba(242,193,78,0.15);
      }
      .evo-tooltip-date {
        font-family: 'Space Mono', monospace;
        font-size: 10px;
        color: #8A8D98;
        margin-bottom: 6px;
      }
      .evo-tooltip-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        padding: 2px 0;
      }
      .evo-tooltip-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .evo-tooltip-title {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: #EDEAE3;
      }
      .evo-tooltip-value {
        font-family: 'Space Mono', monospace;
        font-weight: 700;
        color: #F2C14E;
      }
      .manage-list {
        list-style: none;
        margin: 16px 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .manage-row {
        display: flex;
        align-items: center;
        gap: 10px;
        background: #1A1C24;
        border-radius: 8px;
        padding: 10px 12px;
      }
      .manage-title {
        flex: 1;
        font-size: 14px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .manage-elo {
        font-family: 'Space Mono', monospace;
        font-size: 12px;
        color: #8A8D98;
      }
      .remove-btn {
        background: none;
        border: none;
        color: #C0392B;
        font-size: 20px;
        line-height: 1;
        cursor: pointer;
        padding: 0 4px;
      }
    `}</style>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Cine Elo error:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "16px",
            padding: "24px",
            background: "#101116",
            color: "#EDEAE3",
            fontFamily: "sans-serif",
            textAlign: "center",
          }}
        >
          <p style={{ fontSize: "18px", fontWeight: 700 }}>
            Algo se rompió 🎬💥
          </p>
          <p style={{ fontSize: "13px", color: "#8A8D98", maxWidth: "320px" }}>
            Tu progreso sigue guardado. Recarga la página para volver a
            intentarlo.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "#F2C14E",
              color: "#14151A",
              border: "none",
              fontWeight: 700,
              fontSize: "14px",
              padding: "12px 20px",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            Recargar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function CineElo() {
  return (
    <ErrorBoundary>
      <CineEloApp />
    </ErrorBoundary>
  );
}

