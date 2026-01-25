import React from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import HomeScreen from './screens/HomeScreen';
import CaptureScreen from './screens/CaptureScreen';
import OrganizerScreen from './screens/OrganizerScreen';
import GitHubManagerScreen from './screens/GitHubManagerScreen';

const App: React.FC = () => {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<HomeScreen />} />
                <Route path="/capture" element={<CaptureScreen />} />
                <Route path="/organizer" element={<OrganizerScreen />} />
                <Route path="/github" element={<GitHubManagerScreen />} />
            </Routes>
        </Router>
    );
};

export default App;
